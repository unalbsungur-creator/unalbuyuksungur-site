#!/usr/bin/env python3
"""Müzik eser bilgi formlarını (DOCX) okuyan salt okunur içe aktarım denetleyicisi.

Kullanıcının doldurduğu "MÜZİK ESERİ BİLGİ FORMU" Word belgelerini okur; her
formu katalogdaki eser ve kayıtlarla eşleştirir, şarkı sözlerini, hikâyeyi,
platform bağlantılarını ve yayın onayını denetler, sonucu raporlar.

Yalnızca dry-run çalışır: catalog.json, schema.json ve content/ klasörü yalnızca
okunur, hiçbir şey yayımlanmaz. Rapor ve inceleme metinleri repo dışındaki geçici
bir klasöre yazılır (varsayılan: sistem geçici klasörü). Sözler, hikâyeler ve
özel notlar terminale yazdırılmaz; özel notlar hiçbir dosyaya yazılmaz.

Python standart kütüphanesiyle çalışır (zipfile + xml.etree); ek bağımlılık yoktur.
Bağlantı kuralları validate_catalog.py ile ortaktır. Kurallar: v2/music/data/README.md.

Kullanım:
    python v2/music/tools/import_content_forms.py --input "Form.docx" --dry-run
    python v2/music/tools/import_content_forms.py --input "Form.docx" --report-dir ../rapor

Çıkış kodu: tüm formlar READY_FOR_REVIEW ise 0, inceleme gerektiren form varsa veya
form bulunamazsa 1, girdi/rapor klasörü hatasında 2, katalog dosyaları çalışma
sırasında değiştiyse 3.
"""

import argparse
import datetime
import difflib
import hashlib
import json
import re
import sys
import tempfile
import unicodedata
import zipfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from xml.etree import ElementTree as ET

TOOLS_DIR = Path(__file__).resolve().parent
# v2/ altındaki her dosya yayımlanır; import sırasında __pycache__ oluşturulmaz.
sys.dont_write_bytecode = True
sys.path.insert(0, str(TOOLS_DIR))
from validate_catalog import LINK_HOSTS, url_problem  # noqa: E402  (bağlantı kuralları tek yerde)

MUSIC_ROOT = TOOLS_DIR.parent
DATA_DIR = MUSIC_ROOT / "data"
REPO_ROOT = TOOLS_DIR.parents[2]
DEFAULT_REPORT_ROOT = Path(tempfile.gettempdir()) / "unal-content-import"
# Zip bombası ve aşırı büyük belgelere karşı üst sınır (açılmış document.xml)
MAX_XML_BYTES = 20 * 1024 * 1024

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
W = "{%s}" % W_NS

WORK_ID_RE = re.compile(r"w-\d{4}")
RECORDING_ID_RE = re.compile(r"r-\d{4}")

# --- Form şablonu (Unal_Buyuksungur_Muzik_Eser_Formu.docx) ---------------------
# Bölüm başlıkları "A — ESER / WORK" biçimindedir; harf ve anahtar kelime birlikte aranır.
HEADING_RE = re.compile(r"^\s*([A-E])\s*[—–\-:.)]\s*(\S.*)$")
HEADING_KEYS = {"A": "eser", "B": "soz", "C": "hikaye", "D": "kayit", "E": "yayin"}
SECTION_NAMES = {"A": "Eser", "B": "Şarkı sözleri", "C": "Hikâye", "D": "Kayıt", "E": "Yayın onayı"}

# Tablo alanları: normalize edilmiş etiket -> (anahtar, şablondaki yer tutucu)
A_FIELDS = {
    "eser adı": ("title", "[Şarkının tam adı]"),
    "alternatif ad / eski ad": ("altTitle", "[Varsa]"),
    "work id": ("workId", "[Biliniyorsa w-XXXX; aksi halde boş]"),
    "dil": ("language", "[Türkçe / Almanca / diğer]"),
    "koleksiyon / seri": ("collection", "[Burçlar / Almanca Şarkılar / Özel Günler / diğer]"),
    "söz yazarı": ("lyricist", "[İsim / isimler]"),
    "besteci / müzik": ("composer", "[İsim / isimler veya açıklama]"),
    "yazılma tarihi": ("writtenDate", "[Biliniyorsa; tahmin etmeyin]"),
    "yayın tarihi": ("releaseDate", "[Doğrulanmışsa]"),
}
D_FIELDS = {
    "versiyon / kayıt adı": ("version", "[Orijinal / Akustik / Rock Ballad / vb.]"),
    "recording id": ("recordingId", "[Biliniyorsa r-XXXX]"),
    "orijinal kayıt mı?": ("isOriginal", "[Evet / Hayır / Bilmiyorum]"),
    "müzik tarzı": ("genre", "[Pop, rock, akustik vb.]"),
    "vokal / düzenleme": ("arrangement", "[İsteğe bağlı]"),
    "süre": ("duration", "[dk:sn — biliniyorsa]"),
    "isrc": ("isrc", "[Varsa]"),
    "spotify şarkı/tekli url": ("spotify", "[Tam bağlantı]"),
    "apple music şarkı url": ("appleMusic", "[Tam bağlantı]"),
    "youtube music şarkı url": ("youtubeMusic", "[Tam bağlantı]"),
    "youtube video url": ("youtube", "[Varsa]"),
    "diğer dinleme url": ("other", "[Varsa]"),
    "bu kaydın sözleri farklı mı?": ("lyricsDiffer", "[Hayır / Evet — farklıysa ayrıca ekleyin]"),
}
E_FIELDS = {
    "sözlerin siteye eklenmesi": ("lyrics", "[Onaylı / Henüz onaylamıyorum]"),
    "hikâyenin siteye eklenmesi": ("story", "[Onaylı / Taslak / Yayınlama]"),
    "dinleme bağlantıları": ("links", "[Onaylı / Kontrol edilecek]"),
    "yalnızca özel notlar": ("privateNotes", "[YAYINLANMAYACAK — varsa ayrıca belirtin]"),
}
LINK_FIELDS = ("spotify", "appleMusic", "youtubeMusic", "youtube")
# Onay değerleri ASCII'ye katlanmış hâlleriyle karşılaştırılır; başka her değer "unclear" olur.
APPROVALS = {
    "lyrics": {"onayli": "approved", "henuz onaylamiyorum": "not_approved"},
    "story": {"onayli": "approved", "taslak": "draft", "yayinlama": "do_not_publish"},
    "links": {"onayli": "approved", "kontrol edilecek": "to_check"},
}
YES_NO = {"evet": True, "hayir": False, "bilmiyorum": None}
LANGUAGES = {"turkce": "tr", "almanca": "de", "deutsch": "de", "german": "de", "ingilizce": "en", "english": "en"}
ORIGINAL_WORDS = {"orijinal", "original", "orijinal kayıt", "orijinal version", "ilk kayıt", "ana version"}

LYRICS_PLACEHOLDER = "[ŞARKI SÖZLERİNİ BURAYA YAPIŞTIRIN]"
STORY_PLACEHOLDER = "[YAYINLANMASINI İSTEDİĞİNİZ METİN VEYA TASLAK]"
STORY_LABEL = "Ziyaretçiye açık hikâye (isteğe bağlı):"
# Şablonun sabit metinleri; boşluklar tekleştirilerek birebir karşılaştırılır.
TEMPLATE_PARAGRAPHS = {
    "MÜZİK ESERİ BİLGİ FORMU",
    "Ünal Büyüksungur Digital World V2 | Bir Ömür. Birçok Hikâye.",
    "Her eser için bu formun bir kopyasını doldurun. Bilmediğiniz alanları boş bırakın; şarkı sözlerini ve "
    "bağlantıları aynen yapıştırın. Farklı kayıt/versiyonlar için Kayıt bölümünü çoğaltın.",
    "Sözleri eksiksiz yapıştırın. [Verse], [Chorus], [Bridge], kıta başlıkları, tekrarlar, noktalama ve satır "
    "sonları aynen korunsun.",
    LYRICS_PLACEHOLDER,
    STORY_LABEL,
    STORY_PLACEHOLDER,
    "NOT: Özel notlar otomatik olarak herkese açık hikâyeye aktarılmaz. Dosyalar önce eşleştirme ve onay için "
    "hazırlanır; canlı yayına otomatik alınmaz.",
}

# Durumlar
MATCHED, AMBIGUOUS, NOT_FOUND = "MATCHED", "AMBIGUOUS", "NOT_FOUND"
INCOMPLETE, READY = "INCOMPLETE", "READY_FOR_REVIEW"


class InputError(Exception):
    """Belge okunamadığında (bozuk DOCX, eksik parça, güvensiz XML) yükseltilir."""


# --- Metin yardımcıları --------------------------------------------------------

def collapse(text):
    return re.sub(r"\s+", " ", text).strip()


def tr_lower(text):
    return text.replace("I", "ı").replace("İ", "i").lower()


def ascii_fold(text):
    text = tr_lower(text).replace("ı", "i")
    return "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch))


QUOTES = str.maketrans({"’": "'", "‘": "'", "´": "'", "`": "'", "“": '"', "”": '"', "„": '"'})


def norm_title(text):
    """Kontrollü başlık normalizasyonu: NFC, tırnak birliği, Türkçe küçük harf, boşluk, sondaki nokta/…."""
    text = tr_lower(unicodedata.normalize("NFC", text).translate(QUOTES))
    text = collapse(text).strip('"«»').strip()
    return text.rstrip(".…").rstrip()


def norm_version(text):
    """Versiyon adı: başlık normalizasyonu + parantezsiz + "versiyon/versiyonu" = "version"."""
    text = norm_title(text).replace("(", " ").replace(")", " ")
    return collapse(re.sub(r"\bversiyon(u)?\b", "version", text))


def norm_label(text):
    """Tablo etiketi: ASCII'ye katlanır; "Work ID", "work id" ve "WORK İD" aynı anahtarı verir."""
    return ascii_fold(collapse(text).rstrip("*:： ").strip())


def text_sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# --- DOCX okuma ----------------------------------------------------------------

def local(tag):
    return tag.rsplit("}", 1)[-1]


def is_on(element):
    """w:b, w:vanish gibi aç/kapa özellikleri; w:val="0/false/off/none" kapalıdır."""
    return element is not None and element.get(W + "val") not in ("0", "false", "off", "none")


def run_hidden(run):
    props = run.find(W + "rPr")
    return props is not None and (is_on(props.find(W + "vanish")) or is_on(props.find(W + "specVanish")))


def raw_visible_text(node, hidden=False):
    """Silinmiş (w:del) ve gizli olmayan tüm w:t metinleri, öğe türünden bağımsız."""
    out = []
    for child in node:
        tag = local(child.tag)
        if tag in ("del", "moveFrom"):
            continue
        if tag == "t":
            if not hidden:
                out.append(child.text or "")
        else:
            out.append(raw_visible_text(child, hidden or (tag == "r" and run_hidden(child))))
    return "".join(out)


class Paragraph:
    kind = "p"

    def __init__(self, element, rels):
        props = element.find(W + "pPr")
        style = props.find(W + "pStyle") if props is not None else None
        self.style = style.get(W + "val") if style is not None else ""
        self.issues = []          # (seviye, mesaj): "loss" görünür metin kaybı, "note" bilgi
        self.links = []           # (görünen metin, hedef adres)
        self.formatted = False    # kalın/italik/altı çizili biçim (düz metinde kaybolur)
        parts = []
        self._walk(element, rels, parts)
        self.text = "".join(parts)
        if props is not None and props.find(W + "numPr") is not None:
            self.issues.append(("loss", "liste numarası/madde işareti düz metne alınmadı"))
        # İkinci, öğe türü bilmeyen okuma: atlanmış bir kapsayıcıdaki görünür metni yakalar.
        if self.text.replace("\n", "").replace("\t", "").replace("\u2011", "") != raw_visible_text(element):
            self.issues.append(("loss", "iki bağımsız okuma yöntemi farklı metin verdi"))

    def _walk(self, node, rels, parts, hidden=False):
        for child in node:
            tag = local(child.tag)
            if tag in ("pPr", "rPr", "sdtPr", "sdtEndPr", "bookmarkStart", "bookmarkEnd", "proofErr",
                       "permStart", "permEnd", "commentRangeStart", "commentRangeEnd", "lastRenderedPageBreak"):
                continue
            if tag == "r":
                self._run(child, parts, hidden)
            elif tag == "hyperlink":
                start = len("".join(parts))
                self._walk(child, rels, parts, hidden)
                target = rels.get(child.get("{%s}id" % R_NS)) if child.get("{%s}id" % R_NS) else None
                if target:
                    self.links.append(("".join(parts)[start:], target))
            elif tag in ("del", "moveFrom"):
                if any(t.text for t in child.iter(W + "delText")) or any(t.text for t in child.iter(W + "t")):
                    self.issues.append(("loss", "izlenen değişiklik: silinmiş metin var (değişiklikler kabul edilmeli)"))
            elif tag in ("ins", "moveTo"):
                self.issues.append(("loss", "izlenen değişiklik: eklenmiş metin var (değişiklikler kabul edilmeli)"))
                self._walk(child, rels, parts, hidden)
            elif tag == "fldSimple":
                match = re.search(r'HYPERLINK\s+"([^"]+)"', child.get(W + "instr", ""))
                start = len("".join(parts))
                self._walk(child, rels, parts, hidden)
                if match:
                    self.links.append(("".join(parts)[start:], match.group(1)))
            elif tag in ("smartTag", "customXml", "sdt", "sdtContent", "dir", "bdo"):
                self._walk(child, rels, parts, hidden)
            elif tag in ("oMath", "oMathPara"):
                self.issues.append(("loss", "matematik nesnesi metne alınmadı"))
            else:
                self.issues.append(("loss", f"tanınmayan paragraf öğesi metne alınmadı: {tag}"))

    def _run(self, run, parts, hidden):
        props = run.find(W + "rPr")
        hidden = hidden or run_hidden(run)
        if props is not None:
            if is_on(props.find(W + "caps")) or is_on(props.find(W + "smallCaps")):
                self.issues.append(("loss", "büyük harf biçimi (caps): görünen harfler düz metinden farklı"))
            if any(is_on(props.find(W + name)) for name in ("b", "i", "u", "strike")):
                self.formatted = True
        for item in run:
            tag = local(item.tag)
            if tag == "rPr":
                continue
            if hidden:
                if tag == "t" and item.text:
                    self.issues.append(("note", "gizli (görünmeyen) metin atlandı"))
                continue
            if tag == "t":
                parts.append(item.text or "")
            elif tag == "tab":
                parts.append("\t")
            elif tag in ("br", "cr"):
                if item.get(W + "type") in ("page", "column"):
                    self.issues.append(("note", "sayfa/sütun sonu satır sonu olarak alındı"))
                parts.append("\n")
            elif tag == "noBreakHyphen":
                parts.append("\u2011")
                self.issues.append(("note", "bölünemez tire U+2011 olarak alındı"))
            elif tag == "softHyphen":
                self.issues.append(("note", "yumuşak tire (görünmez) atlandı"))
            elif tag == "sym":
                self.issues.append(("loss", f"sembol karakteri (w:sym {item.get(W + 'char')}) metne alınmadı"))
            elif tag in ("delText", "instrText", "delInstrText", "fldChar", "lastRenderedPageBreak"):
                if tag == "instrText" and item.text:
                    match = re.search(r'HYPERLINK\s+"([^"]+)"', item.text)
                    if match:
                        self.links.append(("", match.group(1)))
            elif tag in ("drawing", "pict", "object"):
                self.issues.append(("loss", "görsel/nesne metne alınmadı"))
            elif tag in ("footnoteReference", "endnoteReference", "commentReference"):
                self.issues.append(("loss", f"{tag}: dipnot/yorum metne alınmadı"))
            else:
                self.issues.append(("loss", f"tanınmayan metin öğesi: {tag}"))


class Table:
    kind = "tbl"

    def __init__(self, element, rels):
        self.rows, self.issues = [], []
        for row in element.iter(W + "tr"):
            cells = []
            for cell in row.findall(W + "tc"):
                if cell.find(".//" + W + "tbl") is not None:
                    self.issues.append(("loss", "iç içe tablo"))
                paragraphs = [Paragraph(p, rels) for p in cell.iter(W + "p")]
                cells.append(paragraphs)
            self.rows.append(cells)


def read_rels(archive):
    try:
        data = archive.read("word/_rels/document.xml.rels")
    except KeyError:
        return {}
    root = safe_xml(data)
    return {rel.get("Id"): rel.get("Target") for rel in root.iter("{%s}Relationship" % PKG_REL_NS)
            if rel.get("Type", "").endswith("/hyperlink")}


def safe_xml(data):
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise InputError("belgede DOCTYPE/ENTITY bildirimi var (güvenlik nedeniyle okunmadı)")
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise InputError(f"XML ayrıştırılamadı: {exc}") from None


def read_docx(path):
    """Belge gövdesini Paragraph/Table blok listesi olarak döndürür."""
    if path.name.startswith("~$"):
        raise InputError("Word kilit dosyası (~$…) okunmaz; asıl belgeyi verin")
    try:
        with zipfile.ZipFile(path) as archive:
            try:
                info = archive.getinfo("word/document.xml")
            except KeyError:
                raise InputError("word/document.xml yok (geçerli bir DOCX değil)") from None
            if info.file_size > MAX_XML_BYTES:
                raise InputError("document.xml beklenmeyecek kadar büyük")
            document = safe_xml(archive.read(info))
            rels = read_rels(archive)
    except zipfile.BadZipFile:
        raise InputError("dosya ZIP/DOCX biçiminde değil veya bozuk") from None
    except OSError as exc:
        raise InputError(f"dosya okunamadı: {exc}") from None
    body = document.find(W + "body")
    if body is None:
        raise InputError("belge gövdesi (w:body) yok")
    blocks, issues = [], []

    def flatten(node):
        for child in node:
            tag = local(child.tag)
            if tag == "p":
                blocks.append(Paragraph(child, rels))
            elif tag == "tbl":
                blocks.append(Table(child, rels))
            elif tag in ("sdt", "sdtContent", "customXml"):
                flatten(child)
            elif tag not in ("sectPr", "sdtPr", "sdtEndPr", "bookmarkStart", "bookmarkEnd"):
                issues.append(f"tanınmayan gövde öğesi atlandı: {tag}")

    flatten(body)
    return blocks, issues


# --- Formlara ayırma -----------------------------------------------------------

def heading_letter(block):
    if block.kind != "p":
        return None
    match = HEADING_RE.match(block.text)
    if match and HEADING_KEYS[match.group(1)] in ascii_fold(match.group(2)):
        return match.group(1)
    return None


def split_forms(blocks):
    """Her "A — ESER" başlığı (veya sırası geriye giden başlık) yeni bir form başlatır."""
    forms, current, region, preamble = [], None, None, []
    for block in blocks:
        letter = heading_letter(block)
        if letter:
            if current is None or letter == "A" or (letter <= region and not letter == region == "D"):
                current = {"sections": {}, "warnings": []}
                forms.append(current)
                if letter != "A":
                    current["warnings"].append("A — Eser bölümü başlığı bulunamadı")
            current["sections"].setdefault(letter, [])
            region = letter
        elif current is None:
            preamble.append(block)
        else:
            current["sections"][region].append(block)
    return forms, preamble


def is_template_text(text):
    return collapse(text) in TEMPLATE_PARAGRAPHS


def read_table(table, fields, warnings, section):
    """Tabloyu {anahtar: {"value", "links", "issues"}} sözlüğüne çevirir; yer tutucular boş sayılır."""
    values = {}
    fields = {norm_label(label): field for label, field in fields.items()}
    for cells in table.rows:
        if len(cells) < 2:
            warnings.append(f"{section}: tek hücreli satır atlandı")
            continue
        label = norm_label("\n".join(p.text for p in cells[0]))
        if label not in fields:
            warnings.append(f"{section}: tanınmayan alan '{collapse(label)[:40]}'")
            continue
        key, placeholder = fields[label]
        paragraphs = [p for cell in cells[1:] for p in cell]
        raw = "\n".join(p.text for p in paragraphs).strip()
        entry = {"value": raw, "links": [l for p in paragraphs for l in p.links],
                 "issues": [i for p in paragraphs for i in p.issues]}
        if collapse(raw) == collapse(placeholder):
            entry["value"] = ""
        elif raw.startswith("[") and raw.endswith("]") and "\n" not in raw:
            entry["placeholderLike"] = True
        if key in values:
            warnings.append(f"{section}: '{key}' alanı birden fazla kez var; ilki kullanıldı")
            continue
        values[key] = entry
    return values


def section_text(blocks, section, label=None):
    """B/C bölümündeki paragrafları satır sonları korunarak düz metne çevirir."""
    lines, issues, formatted = [], [], False
    for block in blocks:
        if block.kind == "tbl":
            issues.append(("loss", f"{section} bölümünde tablo var; tablo metni alınmadı"))
            continue
        if is_template_text(block.text):
            continue
        text = block.text
        if label and text.startswith(label) and text[len(label):].strip():
            text = text[len(label):].lstrip(" ")
            issues.append(("note", "hikâye etiketiyle aynı satırdaki metin etiketten ayrıldı"))
        lines.append(text)
        issues.extend(block.issues)
        formatted = formatted or block.formatted
    text = "\n".join(lines)
    all_lines = text.split("\n")
    lead = next((i for i, l in enumerate(all_lines) if l.strip()), len(all_lines))
    trail = next((i for i, l in enumerate(reversed(all_lines)) if l.strip()), 0)
    if lead == len(all_lines):
        return "", issues, formatted
    if lead or trail:
        issues.append(("note", f"baştaki {lead} / sondaki {trail} boş satır çıkarıldı"))
    text = "\n".join(all_lines[lead:len(all_lines) - trail])
    issues.extend(char_issues(text))
    if formatted:
        issues.append(("note", "kalın/italik/altı çizili biçim düz metinde korunmaz (metin aynen alındı)"))
    return text, issues, formatted


def char_issues(text):
    issues = []
    if any(ord(ch) < 32 and ch not in "\t\n" for ch in text) or "\x7f" in text:
        issues.append(("loss", "kontrol karakteri var (yayın dosyasında izin verilmez)"))
    if "\ufffd" in text:
        issues.append(("loss", "U+FFFD (bozuk karakter) var"))
    if "\u2028" in text or "\u2029" in text:
        issues.append(("loss", "Unicode satır/paragraf ayırıcı (U+2028/2029) var"))
    if any(ch in text for ch in "\u200b\u200c\u200d\ufeff\u00ad"):
        issues.append(("note", "görünmez karakter (sıfır genişlikli boşluk/BOM/yumuşak tire) var"))
    if "\u00a0" in text:
        issues.append(("note", "bölünemez boşluk (U+00A0) var; değiştirilmedi"))
    if "\t" in text:
        issues.append(("note", "sekme karakteri var"))
    if unicodedata.normalize("NFC", text) != text:
        issues.append(("note", "metin NFC biçiminde değil (ayrışık Türkçe karakter olabilir); değiştirilmedi"))
    if any(line != line.rstrip() for line in text.split("\n")):
        issues.append(("note", "satır sonunda boşluk var; değiştirilmedi"))
    return issues


def text_summary(text, issues):
    lines = text.split("\n") if text else []
    stanzas = len([s for s in re.split(r"\n\s*\n", text) if s.strip()]) if text else 0
    losses = sorted({msg for level, msg in issues if level == "loss"})
    return {
        "present": bool(text),
        "lines": len(lines),
        "blankLines": sum(1 for l in lines if not l.strip()),
        "stanzas": stanzas,
        "sectionTags": len(re.findall(r"^\s*\[[^\]]+\]\s*$", text, re.M)),
        "chars": len(text),
        "sha256": text_sha256(text) if text else None,
        "fidelity": ("lossy" if losses else "verified") if text else None,
        "losses": losses,
        "notes": sorted({msg for level, msg in issues if level == "note"}),
    }


# --- Katalog ve eşleştirme -----------------------------------------------------

class Catalog:
    def __init__(self, data):
        self.works = {w["id"]: w for w in data["works"]}
        self.recordings = {r["id"]: r for r in data["recordings"]}
        self.by_work = {}
        for recording in data["recordings"]:
            self.by_work.setdefault(recording["workId"], []).append(recording)
        # (ad, tür, eser, kayıt): eser başlığı, geçici ad ve kayıt başlıkları
        self.names = []
        for work in data["works"]:
            for kind in ("title", "workingTitle"):
                if work.get(kind):
                    self.names.append((work[kind], kind, work["id"], None))
        for recording in data["recordings"]:
            self.names.append((recording["title"], "recordingTitle", recording["workId"], recording["id"]))
        self.link_owner = {}
        for recording in data["recordings"]:
            for key, url in recording["links"].items():
                if key != "other" and url:
                    self.link_owner[url] = (recording["id"], key)
            for item in recording["links"]["other"]:
                self.link_owner[item["url"]] = (recording["id"], "other")

    def label(self, work_id):
        work = self.works[work_id]
        return work["title"] or f"({work['workingTitle']})"

    def find(self, text, normalize):
        key = normalize(text)
        return [(wid, rid, kind) for name, kind, wid, rid in self.names if normalize(name) == key]

    def similar(self, text):
        key, folded = norm_title(text), ascii_fold(norm_title(text))
        found = set()
        for name, _kind, wid, _rid in self.names:
            other = norm_title(name)
            if (ascii_fold(other) == folded
                    or re.search(r"\b%s\b" % re.escape(other), key)
                    or re.search(r"\b%s\b" % re.escape(key), other)
                    or difflib.SequenceMatcher(None, folded, ascii_fold(other)).ratio() >= 0.8):
                found.add(wid)
        return sorted(found)


def unique_work(hits):
    works = sorted({wid for wid, _rid, _kind in hits})
    if len(works) != 1:
        return works, None
    # Yalnızca kayıt başlığı eşleştiyse (ör. "Öyle Bir Şey") o kayıt ipucu olarak taşınır.
    if any(kind != "recordingTitle" for _w, _r, kind in hits):
        return works, None
    recs = sorted({rid for _w, rid, _k in hits})
    return works, recs[0] if len(recs) == 1 else None


def match_work(catalog, title, alt_title, given_id):
    result = {"status": None, "method": None, "workId": None, "recordingHint": None,
              "candidates": [], "conflicts": []}
    exact = catalog.find(title, lambda s: unicodedata.normalize("NFC", collapse(s))) if title else []
    normal = catalog.find(title, norm_title) if title else []
    if given_id:
        gid = given_id.strip().lower()
        title_works = sorted({w for w, _r, _k in exact + normal})
        if not WORK_ID_RE.fullmatch(gid):
            result["conflicts"].append(f"Work ID biçimi geçersiz: '{given_id[:20]}'")
        elif gid not in catalog.works:
            result["conflicts"].append(f"Work ID {gid} katalogda yok")
        elif title and gid not in title_works:
            result["conflicts"].append(f"Work ID {gid} ({catalog.label(gid)}) ile eser adı uyuşmuyor")
        else:
            hint = unique_work([h for h in exact + normal if h[0] == gid])[1] if title else None
            result.update(status=MATCHED, method="work-id", workId=gid, recordingHint=hint)
        if result["conflicts"]:
            cands = set(title_works) | set(catalog.similar(title) if title else [])
            if gid in catalog.works:
                cands.add(gid)
            result.update(status=AMBIGUOUS, candidates=sorted(cands))
            return result
    elif not title:
        result["status"] = NOT_FOUND
        result["conflicts"].append("eser adı ve Work ID yok")
        return result
    else:
        for hits, method in ((exact, "exact-title"), (normal, "normalized-title")):
            works, hint = unique_work(hits)
            if len(works) == 1:
                result.update(status=MATCHED, method=method + ("-recording" if hint else ""),
                              workId=works[0], recordingHint=hint)
                break
            if len(works) > 1:
                result.update(status=AMBIGUOUS, candidates=works)
                result["conflicts"].append("başlık birden fazla eserle eşleşiyor")
                return result
        else:
            cands = sorted(set(catalog.similar(title)) | set(catalog.similar(alt_title) if alt_title else []))
            result["status"] = AMBIGUOUS if cands else NOT_FOUND
            result["candidates"] = cands
            if cands:
                result["conflicts"].append("tam eşleşme yok; benzer başlıklar manuel inceleme gerektirir")
            return result
    if alt_title:
        others = sorted({w for w, _r, _k in catalog.find(alt_title, norm_title)} - {result["workId"]})
        if others:
            result["conflicts"].append(f"alternatif ad başka bir eserle eşleşiyor: {', '.join(others)}")
            result.update(status=AMBIGUOUS, candidates=sorted({result["workId"], *others}))
    return result


def recording_keys(recording, work):
    keys = {norm_version(recording["title"])}
    if recording.get("versionLabel"):
        keys.add(norm_version(recording["versionLabel"]))
    match = re.search(r"\(([^)]*)\)\s*$", recording["title"])
    if match:
        keys.add(norm_version(match.group(1)))
    return keys


def match_recording(catalog, work_id, entry, hint, form_original):
    """Tek bir D tablosunu eserin kayıtlarından birine bağlar; emin değilse AMBIGUOUS döner."""
    result = {"status": None, "method": None, "recordingId": None, "candidates": [], "conflicts": [], "notes": []}
    work = catalog.works[work_id]
    recs = catalog.by_work.get(work_id, [])
    version = entry.get("version", "")
    by_version = []
    if version:
        key = norm_version(version)
        by_version = [r["id"] for r in recs if key in recording_keys(r, work)]
        if not by_version and key in ORIGINAL_WORDS:
            originals = [r["id"] for r in recs if r["isOriginal"] is True]
            if len(originals) == 1:
                by_version = originals
            elif len(recs) == 1 and recs[0]["isOriginal"] is None:
                by_version = [recs[0]["id"]]
                result["notes"].append("katalogda orijinallik bilinmiyor; formdaki 'orijinal' bilgisi yazılmadı")
    given = entry.get("recordingId", "").strip().lower()
    if given:
        if not RECORDING_ID_RE.fullmatch(given):
            result["conflicts"].append(f"Recording ID biçimi geçersiz: '{entry['recordingId'][:20]}'")
        elif given not in catalog.recordings:
            result["conflicts"].append(f"Recording ID {given} katalogda yok")
        elif catalog.recordings[given]["workId"] != work_id:
            result["conflicts"].append(f"Recording ID {given} başka bir esere ait "
                                       f"({catalog.recordings[given]['workId']})")
        elif version and by_version and given not in by_version:
            result["conflicts"].append(f"Recording ID {given} ile versiyon adı farklı kayıtları gösteriyor "
                                       f"({', '.join(by_version)})")
        else:
            result.update(method="recording-id", recordingId=given)
    elif len(by_version) == 1:
        result.update(method="version-name", recordingId=by_version[0])
    elif version and by_version:
        result["conflicts"].append("versiyon adı birden fazla kayıtla eşleşiyor")
    elif version:
        loose = norm_version(version).replace(" version", "").strip()
        near = [r["id"] for r in recs if any(k.replace(" version", "").strip() == loose
                                              for k in recording_keys(r, work))]
        result["conflicts"].append("versiyon adı katalogdaki kayıt adlarıyla birebir eşleşmiyor"
                                   + (f"; olası kayıt: {', '.join(near)}" if near else ""))
        result["candidates"] = near
    elif hint:
        result.update(method="title-recording", recordingId=hint)
    elif form_original is True and len([r for r in recs if r["isOriginal"] is True]) == 1:
        result.update(method="original-flag", recordingId=next(r["id"] for r in recs if r["isOriginal"] is True))
    elif len(recs) == 1:
        result.update(method="only-recording", recordingId=recs[0]["id"])
    else:
        result["conflicts"].append("versiyon adı veya Recording ID olmadan çoklu kayıtlı eser eşleştirilemez")
    if result["recordingId"] and hint and result["recordingId"] != hint:
        result["conflicts"].append(f"eser adı {hint} kaydını, kayıt bilgisi {result['recordingId']} kaydını gösteriyor")
    if result["recordingId"] and form_original is not None:
        catalog_original = catalog.recordings[result["recordingId"]]["isOriginal"]
        if catalog_original is not None and catalog_original != form_original:
            result["conflicts"].append(f"'Orijinal kayıt mı?' yanıtı katalogla çelişiyor ({result['recordingId']})")
        elif catalog_original is None:
            result["notes"].append("katalogda orijinallik bilinmiyor; formdaki yanıt yalnızca raporlandı")
    if result["conflicts"]:
        result["candidates"] = sorted(set(result["candidates"]) | ({result["recordingId"]} - {None})
                                      | set(by_version) | ({given} & set(r["id"] for r in recs)))
        result.update(status=AMBIGUOUS if recs else NOT_FOUND, recordingId=None, method=None)
    else:
        result["status"] = MATCHED
    return result


# --- Bağlantı denetimi ---------------------------------------------------------

def link_kind(platform, url):
    """(tür, sorun, engelleyici) — şarkı/video dışı adresler (sanatçı, liste) engelleyicidir."""
    parts = urlsplit(url)
    host = parts.hostname.lower()
    segs = [s for s in parts.path.split("/") if s]
    query = parse_qs(parts.query)
    if platform == "spotify":
        if host == "spotify.link" or host.endswith(".spotify.link"):
            return "short", "kısa bağlantı; hedef türü çevrimdışı doğrulanamaz", True
        if host != "open.spotify.com":
            return None, "open.spotify.com adresi bekleniyordu", True
        if segs and segs[0].startswith("intl-"):
            segs = segs[1:]
        if len(segs) >= 2 and segs[0] in ("track", "album", "artist", "playlist", "show", "episode", "user"):
            if not re.fullmatch(r"[A-Za-z0-9]{22}", segs[1]):
                return segs[0], "Spotify kimliği 22 karakterli olmalı", True
            if segs[0] == "track":
                return "track", None, False
            if segs[0] == "album":
                return "album", "albüm/tekli yayın bağlantısı (şarkı bağlantısına dönüştürülmedi)", False
            return segs[0], f"şarkı bağlantısı değil ({segs[0]})", True
        return None, "tanınmayan Spotify adres biçimi", True
    if platform == "appleMusic":
        if segs and re.fullmatch(r"[a-z]{2}", segs[0]):
            segs = segs[1:]
        kind = segs[0] if segs else None
        if kind == "song":
            return "song", None, False
        if kind == "album":
            if re.fullmatch(r"\d+", (query.get("i") or [""])[0]):
                return "album-track", None, False
            return "album", "albüm/tekli yayın bağlantısı (şarkı bağlantısına dönüştürülmedi)", False
        if kind in ("artist", "playlist", "curator", "station"):
            return kind, f"şarkı bağlantısı değil ({kind})", True
        return kind, "tanınmayan Apple Music adres biçimi", True
    if platform == "youtubeMusic":
        if segs == ["watch"] and re.fullmatch(r"[A-Za-z0-9_-]{11}", (query.get("v") or [""])[0]):
            return "track", None, False
        if segs == ["playlist"] and query.get("list"):
            return "playlist", "albüm/çalma listesi bağlantısı (şarkı bağlantısına dönüştürülmedi)", False
        if segs and (segs[0] in ("channel", "browse", "artist") or segs[0].startswith("@")):
            return "profile", "sanatçı/kanal profili; şarkı bağlantısı değil", True
        return None, "tanınmayan YouTube Music adres biçimi", True
    if platform == "youtube":
        if host == "music.youtube.com" or host.endswith(".music.youtube.com"):
            return None, "YouTube Music adresi YouTube alanına yazılmış", True
        video = None
        if host == "youtu.be" and len(segs) == 1:
            video = segs[0]
        elif segs == ["watch"]:
            video = (query.get("v") or [""])[0]
        elif len(segs) == 2 and segs[0] in ("shorts", "embed", "live"):
            video = segs[1]
        if video is not None:
            if re.fullmatch(r"[A-Za-z0-9_-]{11}", video):
                return "video", None, False
            return "video", "YouTube video kimliği 11 karakterli olmalı", True
        if segs and (segs[0] in ("channel", "c", "user") or segs[0].startswith("@")):
            return "profile", "kanal/sanatçı profili; video bağlantısı değil", True
        if segs == ["playlist"]:
            return "playlist", "çalma listesi; video bağlantısı değil", True
        return None, "tanınmayan YouTube adres biçimi", True
    return None, None, False


def check_link(platform, entry):
    """Hücredeki tek adresi denetler. Adres hiçbir zaman tahminle düzeltilmez."""
    raw = entry["value"]
    result = {"present": bool(raw), "url": None, "valid": False, "kind": None, "host": None,
              "platformName": None, "problems": [], "warnings": []}
    if not raw:
        return result
    if entry.get("placeholderLike"):
        result["problems"].append("yer tutucu benzeri değer (köşeli parantez)")
        return result
    value = raw
    if platform == "other":
        match = re.fullmatch(r"\s*([^:\s][^:]*?)\s*[:\-–—]\s*(https?://\S+)\s*", raw)
        if match:
            result["platformName"], value = match.group(1), match.group(2)
        else:
            result["problems"].append("diğer platform adı yok ('Platform: https://…' biçiminde yazılmalı)")
    if "\n" in value or " " in value.strip():
        result["problems"].append("hücrede tek bir adres dışında metin var")
        return result
    value = value.strip()
    result["url"] = value
    hosts = LINK_HOSTS.get(platform)
    problem = url_problem(value, hosts)
    if problem:
        result["problems"].append(problem)
        return result
    result["host"] = urlsplit(value).hostname.lower()
    for shown, target in entry.get("links", []):
        if target and target.strip() != value:
            result["problems"].append("Word köprüsünün hedefi görünen adresten farklı")
    if platform == "other":
        for key, key_hosts in LINK_HOSTS.items():
            if url_problem(value, key_hosts) is None:
                result["problems"].append(f"bu adres '{key}' alanına aittir")
    else:
        kind, issue, blocking = link_kind(platform, value)
        result["kind"] = kind
        if issue:
            (result["problems"] if blocking else result["warnings"]).append(issue)
    if re.search(r"[?&](si|feature|pp|utm_[a-z]+)=", value):
        result["warnings"].append("izleme parametresi içeriyor; adres değiştirilmedi")
    result["valid"] = not result["problems"]
    return result


def parse_choice(entry, options):
    """Onay/evet-hayır hücresi: (değer, ham metin). Boş -> "missing", tanınmayan -> "unclear"."""
    raw = (entry or {}).get("value", "")
    if not raw:
        return "missing", ""
    key = collapse(ascii_fold(raw.strip().strip("[]").strip().rstrip(".")))
    return options.get(key, "unclear"), collapse(raw)[:60]


# --- Form değerlendirme --------------------------------------------------------

def evaluate_form(index, form, catalog, music_root):
    """Tek formun raporunu ve (yalnızca rapor klasörüne yazılacak) söz/hikâye metinlerini döndürür."""
    warnings = list(form["warnings"])
    sections = form["sections"]
    report = {"index": index, "missing": [], "missingOptional": [], "errors": [], "conflicts": [],
              "warnings": warnings, "notes": []}
    for letter in "ABCDE":
        if letter not in sections:
            warnings.append(f"{letter} — {SECTION_NAMES[letter]} bölümü bulunamadı")

    def tables(letter):
        return [b for b in sections.get(letter, []) if b.kind == "tbl"]

    def single_table(letter, fields):
        found = tables(letter)
        if len(found) > 1:
            warnings.append(f"{letter} bölümünde birden fazla tablo var; ilki kullanıldı")
        for table in found:
            report["errors"].extend(f"{letter}: {msg}" for _lvl, msg in table.issues)
        return read_table(found[0], fields, warnings, letter) if found else {}

    a = single_table("A", A_FIELDS)
    e = single_table("E", E_FIELDS)
    for letter in ("A", "E"):
        if any(b.kind == "p" and b.text.strip() and not is_template_text(b.text) for b in sections.get(letter, [])):
            warnings.append(f"{letter} bölümünde tablo dışı metin var; içeriği alınmadı")

    def value(fields, key):
        entry = fields.get(key)
        if entry and entry.get("placeholderLike"):
            warnings.append(f"'{key}' alanında yer tutucu benzeri değer var; boş sayıldı")
            return ""
        return entry["value"] if entry else ""

    title = value(a, "title")
    if "\n" in title:
        report["errors"].append("eser adı birden fazla satır içeriyor")
        title = collapse(title)
    alt_title = value(a, "altTitle")
    report["docTitle"] = title or None
    if not title:
        report["missing"].append("Eser adı")

    match = match_work(catalog, title, alt_title, value(a, "workId"))
    report.update(matchStatus=match["status"], matchMethod=match["method"], workId=match["workId"],
                  catalogTitle=catalog.label(match["workId"]) if match["workId"] else None,
                  candidates=[{"workId": w, "title": catalog.label(w)} for w in match["candidates"]])
    report["conflicts"].extend(match["conflicts"])
    work = catalog.works.get(match["workId"]) if match["status"] == MATCHED else None

    language = value(a, "language")
    if language:
        code = LANGUAGES.get(collapse(ascii_fold(language)))
        if code is None:
            report["notes"].append("dil değeri tanınmadı; yalnızca raporlandı")
        elif work and work["language"] != code:
            report["conflicts"].append(f"dil katalogla çelişiyor (form: {code}, katalog: {work['language']})")
    report["extraFields"] = {k: bool(value(a, k)) for k in ("collection", "lyricist", "composer",
                                                            "writtenDate", "releaseDate")}

    # B — Şarkı sözleri, C — Hikâye (metin dosyası olarak rapor klasörüne yazılır, terminale basılmaz)
    lyrics, lyric_issues, _ = section_text(sections.get("B", []), "B")
    story, story_issues, _ = section_text(sections.get("C", []), "C", label=STORY_LABEL)
    report["lyrics"], report["story"] = text_summary(lyrics, lyric_issues), text_summary(story, story_issues)
    if not lyrics:
        report["missing"].append("Şarkı sözleri")
    if not story:
        report["missingOptional"].append("Hikâye")
    for name, summary in (("Şarkı sözleri", report["lyrics"]), ("Hikâye", report["story"])):
        if summary["losses"]:
            report["errors"].append(f"{name}: düz metne dönüşümde kayıp — {'; '.join(summary['losses'])}")
    if story and re.search(r"[\w.+-]+@[\w-]+\.[\w.]+|(\+?\d[\d\s()-]{9,}\d)", story):
        report["warnings"].append("hikâyede e-posta/telefon benzeri kişisel bilgi olabilir; manuel gizlilik kontrolü")

    if work:
        for field, text, published in (("lyrics", lyrics, work["lyrics"]), ("story", story, work["story"])):
            if published["status"] == "published" and text:
                path = music_root / published["file"]
                try:
                    same = path.read_text(encoding="utf-8") == text + "\n"
                except (OSError, UnicodeDecodeError):
                    same = False
                if same:
                    report["notes"].append(f"{field}: yayımlanmış içerikle birebir aynı")
                else:
                    report["conflicts"].append(f"{field}: yayımlanmış içerikten ({published['file']}) farklı; "
                                               "mevcut içerik değiştirilmez, ayrı karar gerekir")
            elif published["status"] == "draft" and text:
                report["notes"].append(f"{field}: katalogda taslak durumunda")

    # D — Kayıtlar: her doldurulmuş tablo bir versiyondur
    report["recordings"] = []
    seen = {}
    for number, table in enumerate(tables("D"), 1):
        entry = read_table(table, D_FIELDS, warnings, f"D#{number}")
        filled = {k: v for k, v in entry.items() if v["value"]}
        if not filled:
            report["notes"].append(f"D#{number}: boş kayıt tablosu yok sayıldı")
            continue
        report["errors"].extend(f"D#{number}: {msg}" for _lvl, msg in table.issues)
        rec = {"table": number, "docVersion": value(entry, "version") or None}
        original, _raw = parse_choice(entry.get("isOriginal"), YES_NO)
        form_original = original if original in (True, False) else None
        if original == "unclear":
            report["warnings"].append(f"D#{number}: 'Orijinal kayıt mı?' değeri tanınmadı")
        rec["isOriginalForm"] = None if original in ("missing", "unclear") else original
        if not rec["docVersion"]:
            report["missing"].append(f"D#{number}: Versiyon / kayıt adı")
        if work:
            plain = {k: value(entry, k) for k in ("version", "recordingId")}
            rmatch = match_recording(catalog, work["id"], plain, match["recordingHint"], form_original)
        else:
            rmatch = {"status": AMBIGUOUS, "method": None, "recordingId": None, "candidates": [],
                      "conflicts": ["eser eşleşmeden kayıt eşleştirilmedi"], "notes": []}
        rec.update(status=rmatch["status"], method=rmatch["method"], recordingId=rmatch["recordingId"],
                   catalogTitle=catalog.recordings[rmatch["recordingId"]]["title"] if rmatch["recordingId"] else None,
                   candidates=rmatch["candidates"])
        if work:
            report["conflicts"].extend(f"D#{number}: {msg}" for msg in rmatch["conflicts"])
        report["notes"].extend(f"D#{number}: {msg}" for msg in rmatch["notes"])
        if rec["recordingId"]:
            if rec["recordingId"] in seen:
                report["conflicts"].append(f"D#{number}: {rec['recordingId']} kaydı D#{seen[rec['recordingId']]} "
                                           "tablosunda da var")
            seen.setdefault(rec["recordingId"], number)
        if ascii_fold(value(entry, "lyricsDiffer")).startswith("evet"):
            report["conflicts"].append(f"D#{number}: kayda özel farklı söz bildirildi; formda konumu tanımlı "
                                       "değil, manuel inceleme")
        rec["links"] = {}
        for platform in LINK_FIELDS + ("other",):
            entry_link = entry.get(platform)
            if not entry_link:
                continue
            checked = check_link(platform, entry_link)
            if not checked["present"]:
                continue
            rec["links"][platform] = checked
            for problem in checked["problems"]:
                report["errors"].append(f"D#{number} {platform}: {problem}")
            for warning in checked["warnings"]:
                report["warnings"].append(f"D#{number} {platform}: {warning}")
            url = checked["url"] if checked["valid"] else None
            if url and url in catalog.link_owner:
                owner, key = catalog.link_owner[url]
                if owner == rec["recordingId"] and key == platform:
                    report["notes"].append(f"D#{number} {platform}: adres katalogda zaten bu kayıtta")
                else:
                    report["conflicts"].append(f"D#{number} {platform}: adres katalogda başka bir kayda/alana "
                                               f"bağlı ({owner}.{key})")
            elif url and rec["recordingId"] and platform != "other":
                existing = catalog.recordings[rec["recordingId"]]["links"].get(platform)
                if existing:
                    report["conflicts"].append(f"D#{number} {platform}: katalogda bu kayıt için farklı bir adres var")
        report["recordings"].append(rec)
    if not report["recordings"] and work:
        recs = catalog.by_work.get(work["id"], [])
        report["notes"].append("doldurulmuş kayıt tablosu yok" + (f"; eserin tek kaydı {recs[0]['id']}"
                                                                   if len(recs) == 1 else ""))
    paragraphs_d = [b for b in sections.get("D", []) if b.kind == "p" and b.text.strip()
                    and not is_template_text(b.text)]
    if paragraphs_d:
        report["conflicts"].append(f"D bölümünde tablo dışı {len(paragraphs_d)} paragraf var (kayda özel söz "
                                   "olabilir); otomatik atanmadı")

    # E — Yayın onayı. Özel notların yalnızca varlığı raporlanır; metni hiçbir yere yazılmaz.
    approvals = {}
    for key in ("lyrics", "story", "links"):
        state, raw = parse_choice(e.get(key), APPROVALS[key])
        approvals[key] = {"value": state, "raw": raw if state == "unclear" else None}
        if state == "unclear":
            report["errors"].append(f"Yayın onayı ({key}): değer tanınmadı — tek bir seçenek bırakılmalı")
    report["approvals"] = approvals
    notes_value = (e.get("privateNotes") or {}).get("value", "")
    report["privateNotes"] = {"present": bool(notes_value), "chars": len(notes_value)}
    has_links = any(r["links"] for r in report["recordings"])
    for key, present, name in (("lyrics", bool(lyrics), "Sözler"), ("story", bool(story), "Hikâye"),
                               ("links", has_links, "Dinleme bağlantıları")):
        if present and approvals[key]["value"] == "missing":
            report["missing"].append(f"Yayın onayı: {name}")
        elif not present and approvals[key]["value"] == "approved":
            report["warnings"].append(f"Yayın onayı ({name}) verilmiş ama içerik yok")

    report["status"] = form_status(report)
    clean = report["status"] == READY
    report["publishEligible"] = {
        "lyrics": clean and approvals["lyrics"]["value"] == "approved" and report["lyrics"]["fidelity"] == "verified",
        "story": clean and approvals["story"]["value"] == "approved" and report["story"]["fidelity"] == "verified",
        "links": clean and approvals["links"]["value"] == "approved" and has_links,
    }
    return report, {"lyrics": lyrics, "story": story}


def form_status(report):
    if report["matchStatus"] == NOT_FOUND:
        return NOT_FOUND
    if report["matchStatus"] == AMBIGUOUS or report["conflicts"] or any(
            r["status"] != MATCHED for r in report["recordings"]):
        return AMBIGUOUS
    if report["missing"] or report["errors"]:
        return INCOMPLETE
    return READY


def cross_check(reports):
    """Aynı eser/başlık veya aynı adres birden fazla formda geçiyorsa hepsini AMBIGUOUS yapar."""
    groups = {}
    for report in reports:
        key = report["workId"] or (norm_title(report["docTitle"]) if report["docTitle"] else None)
        if key:
            groups.setdefault(key, []).append(report)
    urls = {}
    for report in reports:
        for rec in report["recordings"]:
            for platform, link in rec["links"].items():
                if link["valid"]:
                    urls.setdefault(link["url"], []).append((report, rec["table"], platform))
    for key, group in groups.items():
        if len(group) > 1:
            others = ", ".join(f"#{r['index']}" for r in group)
            for report in group:
                report["conflicts"].append(f"aynı eser için birden fazla form var ({others})")
    for url, owners in urls.items():
        if len(owners) > 1:
            where = ", ".join(f"#{r['index']} D#{t} {p}" for r, t, p in owners)
            for report, _t, _p in owners:
                report["conflicts"].append(f"aynı adres birden fazla yerde kullanılmış ({where})")
    for report in reports:
        report["conflicts"] = list(dict.fromkeys(report["conflicts"]))
        report["status"] = form_status(report)
        if report["status"] != READY:
            report["publishEligible"] = {k: False for k in report["publishEligible"]}


# --- Rapor ---------------------------------------------------------------------

def protected_files(catalog_path, music_root):
    files = [catalog_path, catalog_path.parent / "schema.json"]
    content = music_root / "content"
    if content.is_dir():
        files.extend(sorted(p for p in content.rglob("*") if p.is_file()))
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files if p.is_file()}


def choose_report_dir(requested):
    target = (requested or DEFAULT_REPORT_ROOT / datetime.datetime.now().strftime("%Y%m%d-%H%M%S")).resolve()
    if target == REPO_ROOT or REPO_ROOT in target.parents:
        raise InputError(f"rapor klasörü repo içinde olamaz (herkese açık yayımlanabilir): {target}")
    return target


def write_reports(report_dir, summary, reports, texts):
    report_dir.mkdir(parents=True, exist_ok=True)
    text_dir = report_dir / "texts"
    for report in reports:
        for field in ("lyrics", "story"):
            text = texts.get((report["index"], field))
            if text:
                text_dir.mkdir(exist_ok=True)
                name = f"form-{report['index']:02d}-{report['workId'] or 'eslesmedi'}-{field}.txt"
                (text_dir / name).write_bytes((text + "\n").encode("utf-8"))
                report[field]["reviewFile"] = f"texts/{name}"
    (report_dir / "report.json").write_text(
        json.dumps({"summary": summary, "forms": reports}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (report_dir / "report.md").write_text(markdown_report(summary, reports), encoding="utf-8")


def yes_no(flag):
    return "var" if flag else "yok"


def markdown_report(summary, reports):
    out = ["# İçerik formu içe aktarım raporu (DRY-RUN)", "",
           f"- Girdi: `{summary['input']}`", f"- Girdi SHA-256: `{summary['inputSha256']}`",
           f"- Tarih: {summary['createdAt']}", f"- Form sayısı: {summary['formCount']}",
           f"- Katalog ve content/ değişmedi: {'evet' if summary['catalogUnchanged'] else 'HAYIR'}",
           "- Bu rapor yalnızca incelemedir: hiçbir içerik yayımlanmadı, katalog yazılmadı.", ""]
    for note in summary["documentWarnings"]:
        out.append(f"- Belge uyarısı: {note}")
    for report in reports:
        out += ["", f"## Form #{report['index']}: {report['docTitle'] or '(başlıksız)'} — {report['status']}", "",
                "| Alan | Değer |", "|---|---|",
                f"| Katalogdaki başlık | {report['catalogTitle'] or '—'} |",
                f"| Work ID | {report['workId'] or '—'} ({report['matchStatus']}, {report['matchMethod'] or '—'}) |",
                "| Recording ID | " + (", ".join(f"{r['recordingId'] or '?'} ({r['status']})"
                                               for r in report["recordings"]) or "—") + " |",
                f"| Şarkı sözleri | {yes_no(report['lyrics']['present'])}"
                + (f" — {report['lyrics']['lines']} satır, {report['lyrics']['stanzas']} kıta, "
                   f"{report['lyrics']['fidelity']}" if report["lyrics"]["present"] else "") + " |",
                f"| Hikâye | {yes_no(report['story']['present'])}"
                + (f" — {report['story']['chars']} karakter, {report['story']['fidelity']}"
                   if report["story"]["present"] else "") + " |",
                f"| Yayın onayı (söz / hikâye / bağlantı) | " + " / ".join(
                    report["approvals"][k]["value"] for k in ("lyrics", "story", "links")) + " |",
                f"| Özel notlar | {yes_no(report['privateNotes']['present'])} (metin rapora alınmadı) |"]
        if report["candidates"]:
            out.append("| Aday eserler | " + ", ".join(f"{c['workId']} {c['title']}" for c in report["candidates"]) + " |")
        for rec in report["recordings"]:
            links = ", ".join(f"{p}: {'geçerli' if l['valid'] else 'HATALI'} ({l['kind'] or l['host'] or '—'})"
                              for p, l in rec["links"].items()) or "bağlantı yok"
            out.append(f"| D#{rec['table']} {rec['docVersion'] or '(versiyon yok)'} | "
                       f"{rec['recordingId'] or 'aday: ' + (', '.join(rec['candidates']) or '—')} — {links} |")
        for title, items in (("Eksik alanlar", report["missing"]), ("Eksik (isteğe bağlı)", report["missingOptional"]),
                             ("Çakışmalar / manuel karar", report["conflicts"]), ("Hatalar", report["errors"]),
                             ("Uyarılar", report["warnings"]), ("Notlar", report["notes"])):
            if items:
                out += ["", f"**{title}**", ""] + [f"- {item}" for item in items]
    return "\n".join(out) + "\n"


def print_summary(summary, reports, report_dir):
    print(f"Girdi: {summary['input']}  (SHA-256 {summary['inputSha256'][:12]}…)")
    print(f"Form sayısı: {summary['formCount']}   Mod: DRY-RUN (hiçbir şey yayımlanmadı)")
    for note in summary["documentWarnings"]:
        print(f"  Belge uyarısı: {note}")
    for report in reports:
        recs = ",".join(r["recordingId"] or "?" for r in report["recordings"]) or "—"
        links = [l for r in report["recordings"] for l in r["links"].values()]
        approvals = "/".join(report["approvals"][k]["value"] for k in ("lyrics", "story", "links"))
        print()
        print(f"#{report['index']} {report['status']:<16} {report['docTitle'] or '(başlıksız)'}"
              f"  ->  {report['workId'] or '—'} {report['catalogTitle'] or ''}  kayıt: {recs}")
        print(f"   söz: {yes_no(report['lyrics']['present'])}"
              + (f" ({report['lyrics']['lines']} satır, {report['lyrics']['fidelity']})"
                 if report["lyrics"]["present"] else "")
              + f"  hikâye: {yes_no(report['story']['present'])}"
              + f"  bağlantı: {sum(l['valid'] for l in links)}/{len(links)} geçerli"
              + f"  onay(söz/hikâye/bağlantı): {approvals}")
        for title, items in (("eksik", report["missing"]), ("manuel", report["conflicts"]),
                             ("hata", report["errors"])):
            for item in items:
                print(f"   [{title}] {item}")
        if report["warnings"]:
            print(f"   uyarı: {len(report['warnings'])} (ayrıntı raporda)")
    print()
    print(f"Katalog ve content/ değişmedi: {'evet (SHA-256 doğrulandı)' if summary['catalogUnchanged'] else 'HAYIR'}")
    if report_dir:
        print(f"Rapor: {report_dir / 'report.md'}")


# --- Ana akış ------------------------------------------------------------------

def run(input_path, catalog_path, music_root, report_dir):
    before = protected_files(catalog_path, music_root)
    catalog = Catalog(json.loads(catalog_path.read_text(encoding="utf-8")))
    blocks, document_warnings = read_docx(input_path)
    forms, preamble = split_forms(blocks)
    if any(b.kind == "p" and b.text.strip() and not is_template_text(b.text) for b in preamble):
        document_warnings.append("ilk form başlığından önce şablon dışı metin var; alınmadı")
    if input_path.resolve().is_relative_to(REPO_ROOT / "v2"):
        document_warnings.append("girdi belgesi v2/ altında: bu klasördeki her dosya herkese açık yayımlanır")
    elif input_path.resolve().is_relative_to(REPO_ROOT):
        document_warnings.append("girdi belgesi repo içinde: commit edilmemeli (özel içerik)")
    reports, texts = [], {}
    for index, form in enumerate(forms, 1):
        report, form_texts = evaluate_form(index, form, catalog, music_root)
        reports.append(report)
        for field, text in form_texts.items():
            texts[(index, field)] = text
    cross_check(reports)
    if not forms:
        document_warnings.append("belgede müzik eseri formu bulunamadı (A — ESER başlığı yok)")
    after = protected_files(catalog_path, music_root)
    summary = {
        "mode": "dry-run",
        "input": str(input_path),
        "inputSha256": hashlib.sha256(input_path.read_bytes()).hexdigest(),
        "createdAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "formCount": len(forms),
        "statusCounts": {s: sum(r["status"] == s for r in reports) for s in (READY, INCOMPLETE, AMBIGUOUS, NOT_FOUND)},
        "documentWarnings": document_warnings,
        "catalogUnchanged": before == after,
        "protectedFiles": len(before),
    }
    if report_dir:
        write_reports(report_dir, summary, reports, texts)
    return summary, reports


def main():
    parser = argparse.ArgumentParser(description="Müzik eser bilgi formlarını (DOCX) salt okunur denetler.")
    parser.add_argument("--input", type=Path, required=True, help="doldurulmuş form (.docx)")
    parser.add_argument("--dry-run", action="store_true", default=True,
                        help="varsayılan ve tek mod: yalnızca okur ve raporlar")
    parser.add_argument("--catalog", type=Path, default=DATA_DIR / "catalog.json")
    parser.add_argument("--music-root", type=Path, default=None,
                        help="content/ yollarının göreli olduğu klasör (varsayılan: katalogun iki üstü)")
    parser.add_argument("--report-dir", type=Path, default=None,
                        help=f"rapor klasörü; repo dışında olmalı (varsayılan: {DEFAULT_REPORT_ROOT}/<zaman>)")
    args = parser.parse_args()

    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    music_root = (args.music_root or args.catalog.resolve().parent.parent).resolve()
    try:
        if not args.input.is_file():
            raise InputError(f"girdi dosyası bulunamadı: {args.input}")
        report_dir = choose_report_dir(args.report_dir)
        summary, reports = run(args.input, args.catalog.resolve(), music_root, report_dir)
    except InputError as exc:
        print(f"HATA: {exc}", file=sys.stderr)
        sys.exit(2)
    print_summary(summary, reports, report_dir)
    if not summary["catalogUnchanged"]:
        print("HATA: katalog/content dosyaları çalışma sırasında değişti!", file=sys.stderr)
        sys.exit(3)
    sys.exit(0 if reports and all(r["status"] == READY for r in reports) else 1)


if __name__ == "__main__":
    main()
