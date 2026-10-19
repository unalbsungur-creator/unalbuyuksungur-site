#!/usr/bin/env python3
"""Şarkı arşivi Word belgesini okuyan salt okunur içe aktarım denetleyicisi (Görev 14).

Kaynak: kullanıcının toplu şarkı arşivi Word belgesi — Word'ün otomatik numaralı
başlıklarıyla ayrılmış eser bölümleri; her bölümde söz ve (varsa) "Hikayesi:" ile
başlayan hikâye. Araç bölümleri kayıpsız ayırır, katalogdaki Work/Recording
kayıtlarıyla eşleştirir ve kullanıcının onayladığı içerik kurallarını (burçların
ortak hikâyesi, iki versiyonlu eserlerin ortak hikâyesi, versiyona özel sözler)
bir dry-run manifestinde gösterir.

Yalnızca dry-run çalışır: kaynak belge, catalog.json, schema.json ve content/
yalnızca okunur; söz/hikâye dosyası yazılmaz. Rapor repo dışındaki bir klasöre
yazılır ve söz/hikâye metni içermez (başlık, kimlik, durum, satır sayısı, hash).

DOCX okuma import_content_forms.py ile ortaktır (iki bağımsız okuma doğrulaması,
güvenli XML). Python standart kütüphanesiyle çalışır.

Kullanım:
    python v2/music/tools/import_song_archive.py --source arsiv/kaynak.docx --dry-run
    python v2/music/tools/import_song_archive.py --source arsiv/kaynak.docx --report-dir ../rapor
    python v2/music/tools/import_song_archive.py --source arsiv/kaynak.docx --privacy-review ../gizlilik.json

Gizlilik incelemesi: hikâyeler genel kalıplarla (e-posta/telefon, sosyal medya hesabı, sağlık, yas) taranır.
Eser bazında inceleme kararları kaynak kodda tutulmaz; gerekirse repo dışındaki bir JSON dosyasıyla
({"w-0001": "kategori", ...}) --privacy-review parametresiyle verilir.

Çıkış kodu: analiz yapısal sorun olmadan tamamlandıysa 0 (bekleyen kullanıcı kararları
raporlanır), yapısal sorun varsa 1, girdi/rapor klasörü hatasında 2, kaynak veya
katalog dosyaları çalışma sırasında değiştiyse 3.
"""

import argparse
import collections
import datetime
import difflib
import hashlib
import json
import re
import sys
import unicodedata
import zipfile
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
# v2/ altındaki her dosya yayımlanır; import sırasında __pycache__ oluşturulmaz.
sys.dont_write_bytecode = True
sys.path.insert(0, str(TOOLS_DIR))
import import_content_forms as forms  # noqa: E402  (DOCX okuma ve ortak yardımcılar)

W = forms.W
MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
W16SE = "{http://schemas.microsoft.com/office/word/2015/wordml/symex}"
DATA_DIR, MUSIC_ROOT, REPO_ROOT = forms.DATA_DIR, forms.MUSIC_ROOT, forms.REPO_ROOT
DEFAULT_REPORT_ROOT = forms.DEFAULT_REPORT_ROOT.parent / "unal-song-archive"
InputError = forms.InputError

# --- Kullanıcı kararları (Görev 13–14) ------------------------------------------
# Kararlar bu kaynak sürümü için verildi; farklı bir sürümde rapor uyarı verir.
APPROVED_SOURCE_SHA256 = "e9151e8e283646c44a34eb9894203bb5dbad7e3ab7e6e223ac20a03d2a7fb3a0"
# Kullanıcının onayladığı başlık eşleşmeleri: Word başlığı -> (Work, Recording veya None)
APPROVED_MATCHES = {
    "Kiminle?": ("w-0043", None),
    "Neredeyim Ben?": ("w-0048", None),
    "Neredesin?": ("w-0047", None),
    "Boş ver Geç": ("w-0019", None),
    "Beni Yar Seçtin": ("w-0012", None),
    "ICH MELD' MICH": ("w-0037", None),
    "Yenik Yüreğim (Thrash Metal )": ("w-0061", "r-0065"),
    "Öyle Bir Şey (Akustik )": ("w-0020", "r-0051"),
    "Böyle Bir Şey (Rock'n Roll)": ("w-0020", "r-0021"),
}
# 12 burç eserinin ortak hikâyesi (birebir). Kapsam katalogdaki koleksiyondan okunur.
ZODIAC_COLLECTION_SLUG = "burc-serisi"
ZODIAC_STORY = "2026/ Sosyal Medyada paylaşılan resim/videolara eklensin diye yazdım. Bol bol ekleyin."
# İki versiyonu aynı hikâyeyi paylaşan eserler: Biliyorum, Öyle/Böyle Bir Şey, Turizmci, Yenik Yüreğim
SHARED_STORY_WORKS = ("w-0014", "w-0020", "w-0056", "w-0061")
# Hikâyeler için genel gizlilik taraması (yalnızca işaret; metin değiştirilmez). Eser bazında inceleme kararları
# herkese açık kaynak kodda tutulmaz; repo dışındaki bir dosyadan --privacy-review ile okunur.
PRIVACY_PATTERNS = {
    "sosyal medya hesabı": r"@\w{3,}",
    "adı geçen kişi": r"\b[A-ZÇĞİÖŞÜ][a-zçğıöşü]+ (Hanım|Bey)\b",
    "sağlık bilgisi": r"(?i)ameliyat|hastane|teşhis|tedavi|kanser",
    "yas/kayıp": r"(?i)\byas\b|kayıp|kaybett|vefat",
    "e-posta/telefon": r"[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s()-]{9,}\d",
}

# --- Belge yapısı ---------------------------------------------------------------
# "Hikayesi:", "Hikayesi :", "Hikayesi 2026/", "Hikayesi:1995" — yalnızca paragraf başında.
STORY_MARKER = re.compile(r"^\s*Hik[aâ]yesi(?=[\s:]|$)\s*:?\s*", re.I)
# İşaretsiz hikâye adayı: "2026/ …", "1994-1996/ …" ile başlayan son söz paragrafı
YEAR_LINE = re.compile(r"^\s*(19|20)\d{2}(\s*-\s*(19|20)\d{2})?\s*/")
EMOJI = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF]")
QUOTES = str.maketrans({"’": "'", "‘": "'", "´": "'", "`": "'"})

# Durumlar
EXACT, NORMALIZED, USER_APPROVED = "EXACT", "NORMALIZED", "USER_APPROVED"
PROBABLE, NOT_FOUND = "PROBABLE_PENDING", "NOT_FOUND"
CONFIRMED_MATCHES = (EXACT, NORMALIZED, USER_APPROVED)
PENDING, RESOLVED = "PENDING_APPROVAL", "RESOLVED"


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def title_key(text):
    """Onaylı eşleşme anahtarı: NFC, tırnak birliği, boşluk; büyük/küçük harf korunur."""
    return forms.collapse(unicodedata.normalize("NFC", text).translate(QUOTES))


def safe_norm(text):
    """Güvenli normalizasyon: + Türkçe küçük harf, sondaki nokta/üç nokta."""
    return forms.tr_lower(title_key(text)).rstrip(".…").rstrip()


def loose(text):
    """Yalnızca öneri için: noktalama, aksan ve boşluk farkı yok sayılır."""
    folded = forms.ascii_fold(safe_norm(text))
    return re.sub(r"[^a-z0-9]", "", folded)


# --- DOCX okuma -----------------------------------------------------------------

def numbered_styles(archive):
    """Numaralandırmayı stil üzerinden alan paragraf stilleri (w:style/w:pPr/w:numPr)."""
    try:
        root = forms.safe_xml(archive.read("word/styles.xml"))
    except KeyError:
        return set()
    return {style.get(W + "styleId") for style in root.iter(W + "style")
            if style.find(f"{W}pPr/{W}numPr") is not None}


def resolve_alternate_content(root):
    """mc:AlternateContent öğelerini Markup Compatibility kuralıyla mc:Fallback içeriğine indirger.

    Word emojileri <mc:Choice><w16se:symEx w16se:char="1F60A"/></mc:Choice><mc:Fallback><w:t>😊</w:t></mc:Fallback>
    olarak yazar. Fallback metni kullanılır; Choice'taki sembol kodu Fallback metniyle aynı değilse sayılır.
    """
    resolved, mismatched = 0, 0
    for parent in list(root.iter()):
        for index, child in reversed(list(enumerate(list(parent)))):
            if child.tag != MC + "AlternateContent":
                continue
            fallback = child.find(MC + "Fallback")
            choice_chars = "".join(chr(int(sym.get(W16SE + "char"), 16)) for sym in child.iter(W16SE + "symEx")
                                   if re.fullmatch(r"[0-9A-Fa-f]{1,6}", sym.get(W16SE + "char", "")))
            fallback_text = "".join(t.text or "" for t in fallback.iter(W + "t")) if fallback is not None else ""
            if choice_chars and choice_chars != fallback_text:
                mismatched += 1
            parent.remove(child)
            for offset, item in enumerate(list(fallback) if fallback is not None else []):
                parent.insert(index + offset, item)
            resolved += 1
    return resolved, mismatched


def read_archive(path):
    """Gövdeyi paragraf listesi olarak döndürür: metin, numara anahtarı, sorunlar."""
    if path.name.startswith("~$"):
        raise InputError("Word kilit dosyası (~$…) okunmaz; belge Word'de açık olabilir")
    try:
        with zipfile.ZipFile(path) as archive:
            try:
                info = archive.getinfo("word/document.xml")
            except KeyError:
                raise InputError("word/document.xml yok (geçerli bir DOCX değil)") from None
            if info.file_size > forms.MAX_XML_BYTES:
                raise InputError("document.xml beklenmeyecek kadar büyük")
            document = forms.safe_xml(archive.read(info))
            rels = forms.read_rels(archive)
            styled = numbered_styles(archive)
    except zipfile.BadZipFile:
        raise InputError("dosya ZIP/DOCX biçiminde değil veya bozuk") from None
    except OSError as exc:
        raise InputError(f"dosya okunamadı: {exc}") from None
    body = document.find(W + "body")
    if body is None:
        raise InputError("belge gövdesi (w:body) yok")
    alternates = resolve_alternate_content(body)
    paragraphs = []

    def flatten(node):
        for child in node:
            tag = forms.local(child.tag)
            if tag == "p":
                props = child.find(W + "pPr")
                num = props.find(W + "numPr") if props is not None else None
                style = props.find(W + "pStyle") if props is not None else None
                style = style.get(W + "val") if style is not None else ""
                key = None
                if num is not None:
                    num_id, level = num.find(W + "numId"), num.find(W + "ilvl")
                    key = (num_id.get(W + "val") if num_id is not None else "?",
                           level.get(W + "val") if level is not None else "0")
                elif style in styled:
                    key = (f"style:{style}", "0")
                para = forms.Paragraph(child, rels)
                issues = [i for i in para.issues if not (key and "liste numarası" in i[1])]
                page = any(forms.local(n.tag) == "lastRenderedPageBreak"
                           or (forms.local(n.tag) == "br" and n.get(W + "type") == "page") for n in child.iter())
                paragraphs.append({"text": para.text, "num": key, "issues": issues, "pageBreak": page})
            elif tag == "tbl":
                paragraphs.append({"text": "", "num": None, "pageBreak": False,
                                   "issues": [("loss", "tablo: metni bölümlere alınmadı")]})
            elif tag in ("sdt", "sdtContent", "customXml"):
                flatten(child)

    flatten(body)
    return paragraphs, {"alternateContentResolved": alternates[0], "alternateContentMismatched": alternates[1]}


# --- Bölümlere ayırma -----------------------------------------------------------

def trim_range(indexes, paragraphs):
    """Baştaki/sondaki boş paragrafları ayırır: (içerik, kenar boşlukları)."""
    filled = [i for i in indexes if paragraphs[i]["text"].strip()]
    if not filled:
        return [], list(indexes)
    inner = [i for i in indexes if filled[0] <= i <= filled[-1]]
    return inner, [i for i in indexes if i not in inner]


def text_stats(text):
    lines = text.split("\n") if text else []
    return {
        "lines": len(lines),
        "nonEmpty": sum(1 for l in lines if l.strip()),
        "blank": sum(1 for l in lines if not l.strip()),
        "stanzas": len([s for s in re.split(r"\n\s*\n", text) if s.strip()]) if text else 0,
        "emoji": len(EMOJI.findall(text)),
        "germanSpecific": sum(text.count(c) for c in "äÄß"),
        "sha256": sha(text) if text else None,
    }


def split_sections(paragraphs):
    """Word'ün otomatik numaralı başlıkları (ilk numaralı paragrafın listesi, düzey 0) bölüm sınırıdır.

    Sayfa sonları sınır sayılmaz. Her paragraf tam olarak bir role atanır; toplam kontrol edilir.
    """
    roles = [None] * len(paragraphs)
    numbered = [p["num"] for p in paragraphs if p["num"]]
    if not numbered:
        return [], roles
    title_num = numbered[0] if numbered[0][1] == "0" else (numbered[0][0], "0")
    titles = [i for i, p in enumerate(paragraphs) if p["num"] == title_num]
    for i in range(titles[0] if titles else len(paragraphs)):
        roles[i] = "preamble"
    sections = []
    for n, start in enumerate(titles, 1):
        end = titles[n] if n < len(titles) else len(paragraphs)
        roles[start] = "title"
        body = list(range(start + 1, end))
        issues = [msg for i in range(start, end) for level, msg in paragraphs[i]["issues"] if level == "loss"]
        issues += [f"başlık dışı numaralı paragraf ({paragraphs[i]['num'][0]}/{paragraphs[i]['num'][1]})"
                   for i in body if paragraphs[i]["num"]]
        markers = [i for i in body if STORY_MARKER.match(paragraphs[i]["text"])]
        lyric_part = [i for i in body if not markers or i < markers[0]]
        lyric_idx, lyric_edges = trim_range(lyric_part, paragraphs)
        for i in lyric_idx:
            roles[i] = "lyrics"
        for i in lyric_edges:
            roles[i] = "blank-edge"
        lyrics = "\n".join(paragraphs[i]["text"] for i in lyric_idx)

        story, marker_form, separate = "", None, False
        if markers:
            first = markers[0]
            match = STORY_MARKER.match(paragraphs[first]["text"])
            marker_form = forms.collapse(match.group(0)) or match.group(0)
            remainder = paragraphs[first]["text"][match.end():]
            separate = not remainder.strip()
            roles[first] = "story-marker"
            following = [i for i in body if i > first]
            rest_idx, rest_edges = trim_range(following, paragraphs)
            if not separate and rest_idx:
                # İşaret satırında metin varsa aradaki boş paragraflar hikâyenin parçasıdır.
                rest_idx = [i for i in following if i <= rest_idx[-1]]
                rest_edges = [i for i in following if i > rest_idx[-1]]
            lines = ([remainder] if not separate else []) + [paragraphs[i]["text"] for i in rest_idx]
            for i in rest_idx:
                roles[i] = "story"
            for i in rest_edges:
                roles[i] = "blank-edge"
            story = "\n".join(lines)
            if len(markers) > 1:
                issues.append(f"bölümde {len(markers)} hikâye işareti var (ilki kullanıldı, diğerleri hikâye metninde)")
        candidate = None
        if not markers and lyric_idx and YEAR_LINE.match(paragraphs[lyric_idx[-1]]["text"]):
            text = paragraphs[lyric_idx[-1]]["text"]
            candidate = {"offset": lyric_idx[-1] - start, "sha256": sha(text), "chars": len(text),
                         "equalsZodiacStory": text == ZODIAC_STORY}
        sections.append({
            "section": n,
            "sourceTitle": paragraphs[start]["text"],
            "paragraphs": [start, end],
            "pageBreaks": sum(1 for i in range(start, end) if paragraphs[i]["pageBreak"]),
            "lyrics": lyrics,
            "story": story,
            "storyMarker": marker_form,
            "storyMarkerSeparate": separate,
            "unmarkedStoryCandidate": candidate,
            "lyricsHikayeWord": sum(1 for l in lyrics.split("\n") if re.search(r"(?i)hik[aâ]ye", l)),
            "issues": issues,
        })
    return sections, roles


# --- Eşleştirme -----------------------------------------------------------------

class Catalog:
    def __init__(self, data):
        self.data = data
        self.works = {w["id"]: w for w in data["works"]}
        self.recordings = {r["id"]: r for r in data["recordings"]}
        self.by_work = collections.defaultdict(list)
        for r in data["recordings"]:
            self.by_work[r["workId"]].append(r["id"])
        self.names = [(w[k], w["id"], None) for w in data["works"] for k in ("title", "workingTitle") if w.get(k)]
        self.names += [(r["title"], r["workId"], r["id"]) for r in data["recordings"]]

    def label(self, work_id):
        work = self.works[work_id]
        return work["title"] or work["workingTitle"]

    def zodiac_works(self):
        found = [c for c in self.data["collections"] if c["slug"] == ZODIAC_COLLECTION_SLUG]
        return [m["workId"] for m in found[0]["members"]] if len(found) == 1 else []


def resolve_recording(catalog, work_id, hits):
    """Kayıt başlığıyla tek eşleşme veya tek kayıtlı eser; aksi hâlde None."""
    recs = sorted({r for _w, r in hits if r})
    if len(recs) == 1:
        return recs[0]
    if len(catalog.by_work[work_id]) == 1:
        return catalog.by_work[work_id][0]
    return None


def match_section(catalog, title):
    result = {"match_status": NOT_FOUND, "work_id": None, "recording_id": None,
              "recording_status": None, "candidates": []}
    approved = {title_key(k): v for k, v in APPROVED_MATCHES.items()}.get(title_key(title))
    if approved:
        work_id, rec_id = approved
        if work_id in catalog.works and (rec_id is None or catalog.recordings.get(rec_id, {}).get("workId") == work_id):
            rec_id = rec_id or resolve_recording(catalog, work_id, [])
            result.update(match_status=USER_APPROVED, work_id=work_id, recording_id=rec_id)
        else:
            result["candidates"] = [work_id]
            result["match_status"] = PROBABLE
        return result
    for status, key in ((EXACT, lambda s: unicodedata.normalize("NFC", s)), (NORMALIZED, safe_norm)):
        hits = [(w, r) for name, w, r in catalog.names if key(name) == key(title)]
        works = sorted({w for w, _r in hits})
        if len(works) == 1:
            result.update(match_status=status, work_id=works[0], recording_id=resolve_recording(catalog, works[0], hits))
            return result
        if len(works) > 1:
            result.update(match_status=PROBABLE, candidates=works)
            return result
    target = loose(title)
    cands = sorted({w for name, w, _r in catalog.names
                    if target and (loose(name) == target or loose(name).startswith(target)
                                   or target.startswith(loose(name))
                                   or difflib.SequenceMatcher(None, target, loose(name)).ratio() >= 0.8)})
    if cands:
        result.update(match_status=PROBABLE, candidates=cands)
    return result


def assign_recordings(catalog, sections):
    """Onaylı kayıtları işaretler; eseri kesin ama kaydı açık olmayan bölüme eleme yoluyla aday önerir."""
    taken = collections.defaultdict(list)
    for s in sections:
        if s["match"]["recording_id"] and s["match"]["match_status"] in CONFIRMED_MATCHES:
            s["match"]["recording_status"] = "CONFIRMED"
            taken[s["match"]["recording_id"]].append(s["section"])
    for s in sections:
        m = s["match"]
        if m["match_status"] in CONFIRMED_MATCHES and not m["recording_id"]:
            free = [r for r in catalog.by_work[m["work_id"]] if r not in taken]
            m["recording_status"] = PROBABLE
            m["recording_candidates"] = free
            if len(free) == 1:
                m["recording_id"] = free[0]
        elif m["match_status"] == PROBABLE and len(m["candidates"]) == 1:
            m["work_id"] = m["candidates"][0]
            free = [r for r in catalog.by_work[m["work_id"]] if r not in taken]
            m["recording_status"] = PROBABLE
            m["recording_candidates"] = free
            m["recording_id"] = free[0] if len(free) == 1 else None
    return {r: secs for r, secs in taken.items() if len(secs) > 1}


# --- İçerik planı ---------------------------------------------------------------

def privacy_flags(work_id, story, review=None):
    flags = [review[work_id]] if review and work_id in review else []
    flags += [name for name, pattern in PRIVACY_PATTERNS.items() if story and re.search(pattern, story)]
    return sorted(set(flags))


def published_conflicts(work, plan_texts, music_root):
    out = []
    for field in ("lyrics", "story"):
        asset, text = work[field], plan_texts.get(field)
        if asset["status"] != "published" or not text:
            continue
        try:
            published = (music_root / asset["file"]).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            published = None
        if published != text + "\n":
            out.append({"field": field, "file": asset["file"], "status": PENDING,
                        "sourceSha256": sha(text),
                        "publishedSha256": sha(published.rstrip("\n")) if published is not None else None})
    return out


def plan_work(catalog, work_id, secs, zodiac, music_root, privacy_review=None):
    """Bir eserin söz/hikâye planı. Metin değil, kapsam ve hash taşır."""
    work = catalog.works[work_id]
    confirmed = [s for s in secs if s["match"]["match_status"] in CONFIRMED_MATCHES
                 and s["match"]["recording_status"] == "CONFIRMED"]
    pending_reasons = []
    # Sözler: tüm versiyonların sözü birebir aynıysa eser düzeyinde tek metin; değilse kayıt düzeyinde.
    lyric_hashes = {s["lyricsStats"]["sha256"] for s in secs}
    lyrics_plan = []
    if len(secs) == 1 or len(lyric_hashes) == 1:
        lyrics_plan.append({"scope": "work", "target": f"work:{work_id}", "file": f"content/lyrics/{work_id}.txt",
                            "sha256": secs[0]["lyricsStats"]["sha256"], "sections": [s["section"] for s in secs]})
    else:
        for s in secs:
            rec = s["match"]["recording_id"]
            lyrics_plan.append({"scope": "recording", "target": f"recording:{rec or '?'}",
                                "file": f"content/lyrics/{rec}.txt" if rec else None,
                                "sha256": s["lyricsStats"]["sha256"], "sections": [s["section"]],
                                "status": RESOLVED if s in confirmed else PENDING})
        pending_reasons.append("work.lyrics varsayılanı: versiyon sözleri farklı, eser düzeyi metin seçilmedi")
    for s in secs:
        if s["unmarkedStoryCandidate"]:
            pending_reasons.append(f"bölüm {s['section']}: son söz paragrafı işaretsiz hikâye adayı (söz/hikâye sınırı)")
    if any(s not in confirmed for s in secs):
        pending_reasons.append("eşleşme/kayıt onayı: bölüm " + ", ".join(str(s["section"]) for s in secs
                                                                         if s not in confirmed))

    # Hikâye: kaynak hikâyeler ayrı, uygulanacak hikâye ayrı temsil edilir.
    sources = [{"section": s["section"], "sha256": sha(s["story"]), "chars": len(s["story"]),
                "marker": s["storyMarker"], "markerSeparate": s["storyMarkerSeparate"]}
               for s in secs if s["story"]]
    story = {"scope": "work", "target": f"work:{work_id}", "file": f"content/stories/{work_id}.txt",
             "sources": sources, "status": RESOLVED}
    if work_id in zodiac:
        story.update(rule="ZODIAC_SHARED", sha256=sha(ZODIAC_STORY), chars=len(ZODIAC_STORY),
                     sourceDiffersFromApplied=any(src["sha256"] != sha(ZODIAC_STORY) for src in sources))
    elif work_id in SHARED_STORY_WORKS:
        basis = [src for src in sources if any(s["section"] == src["section"] for s in confirmed)] or sources
        hashes = {src["sha256"] for src in basis}
        if len(hashes) == 1:
            story.update(rule="VERSION_SHARED", sha256=basis[0]["sha256"], chars=basis[0]["chars"])
        else:
            story.update(rule="VERSION_SHARED", sha256=None, status=PENDING)
            pending_reasons.append(f"ortak hikâye seçimi: {len(hashes)} farklı kaynak hikâye")
        unconfirmed = [src for src in sources if src not in basis or src["sha256"] not in hashes]
        story["unconfirmedSourcesDiffer"] = bool(unconfirmed)
    elif sources:
        story.update(rule="SOURCE", sha256=sources[0]["sha256"], chars=sources[0]["chars"])
    elif any(s["unmarkedStoryCandidate"] for s in secs):
        cand = next(s["unmarkedStoryCandidate"] for s in secs if s["unmarkedStoryCandidate"])
        story.update(rule="UNMARKED_CANDIDATE", sha256=None, status=PENDING, candidateSha256=cand["sha256"],
                     candidateEqualsZodiacStory=cand["equalsZodiacStory"])
    else:
        story.update(rule="MISSING", sha256=None, status=None)

    applied_story = ZODIAC_STORY if story.get("rule") == "ZODIAC_SHARED" else next(
        (s["story"] for s in secs if s["story"] and sha(s["story"]) == story.get("sha256")), "")
    texts = {"lyrics": secs[0]["lyrics"] if lyrics_plan[0]["scope"] == "work" else None, "story": applied_story}
    conflicts = published_conflicts(work, texts, music_root)
    if conflicts:
        pending_reasons.append("yayımlanmış içerikle çakışma: " + ", ".join(c["file"] for c in conflicts))
    privacy = privacy_flags(work_id, "\n".join([applied_story] + [s["story"] for s in secs]), privacy_review)
    lossy = sorted({i for s in secs for i in s["issues"]})
    return {
        "work_id": work_id,
        "catalogTitle": catalog.label(work_id),
        "recordings": catalog.by_work[work_id],
        "sections": [s["section"] for s in secs],
        "lyrics": lyrics_plan,
        "story": story,
        "privacy_review_required": bool(privacy),
        "privacyCategories": privacy,
        "conflicts": conflicts,
        "integrity": "lossy" if lossy else "lossless",
        "integrityIssues": lossy,
        "approval_status": PENDING if pending_reasons or privacy else "READY_FOR_PUBLISH_APPROVAL",
        "pending": pending_reasons + (["gizlilik incelemesi"] if privacy else []),
    }


# --- Ana analiz -----------------------------------------------------------------

def analyze(source, catalog_data, music_root, expect_sections=None, privacy_review=None):
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    paragraphs, markup = read_archive(source)
    sections, roles = split_sections(paragraphs)
    catalog = Catalog(catalog_data)
    for s in sections:
        s["match"] = match_section(catalog, s["sourceTitle"])
        s["lyricsStats"] = text_stats(s["lyrics"])
    duplicate_recordings = assign_recordings(catalog, sections)

    structural = []
    unassigned = [i for i, r in enumerate(roles) if r is None]
    if unassigned:
        structural.append(f"{len(unassigned)} paragraf hiçbir bölüme atanamadı")
    if markup["alternateContentMismatched"]:
        structural.append(f"{markup['alternateContentMismatched']} mc:AlternateContent öğesinde sembol ve "
                          "yedek metin farklı")
    if expect_sections is not None and len(sections) != expect_sections:
        structural.append(f"{expect_sections} bölüm bekleniyordu, {len(sections)} bulundu")
    if any(p["text"].strip() for p, r in zip(paragraphs, roles) if r == "preamble"):
        structural.append("ilk başlıktan önce metin var")
    for rec, secs in duplicate_recordings.items():
        structural.append(f"{rec} birden fazla bölüme bağlı: {secs}")
    for s in sections:
        if s["match"]["match_status"] == NOT_FOUND:
            structural.append(f"bölüm {s['section']}: katalogda bulunamadı")
        if s["issues"]:
            structural.append(f"bölüm {s['section']}: dönüşüm kaybı — {'; '.join(sorted(set(s['issues'])))}")

    zodiac = catalog.zodiac_works()
    zodiac_problem = None if len(zodiac) == 12 and all(w in catalog.works for w in zodiac) else \
        f"burç koleksiyonu ({ZODIAC_COLLECTION_SLUG}) 12 geçerli eser içermiyor"
    if zodiac_problem:
        structural.append(zodiac_problem)
        zodiac = []

    by_work = collections.defaultdict(list)
    for s in sections:
        if s["match"]["work_id"]:
            by_work[s["match"]["work_id"]].append(s)
    works = [plan_work(catalog, wid, secs, zodiac, music_root, privacy_review) for wid, secs in sorted(by_work.items())]
    covered_recs = {s["match"]["recording_id"] for s in sections if s["match"]["recording_id"]}
    confirmed_recs = {s["match"]["recording_id"] for s in sections if s["match"].get("recording_status") == "CONFIRMED"}

    manifest = []
    plan_by_work = {w["work_id"]: w for w in works}
    for s in sections:
        m, plan = s["match"], plan_by_work.get(s["match"]["work_id"])
        lyric_entry = next((l for l in (plan["lyrics"] if plan else []) if s["section"] in l["sections"]), None)
        manifest.append({
            "source_section": s["section"],
            "source_title": s["sourceTitle"],
            "source_hash": source_hash,
            "source_paragraphs": s["paragraphs"],
            "work_id": m["work_id"],
            "recording_id": m["recording_id"],
            "match_status": m["match_status"],
            "recording_status": m["recording_status"],
            "candidates": m.get("candidates") or m.get("recording_candidates") or [],
            "lyrics_source": s["lyricsStats"],
            "lyrics_scope": lyric_entry["scope"] if lyric_entry else None,
            "story_source": ({"present": bool(s["story"]), "sha256": sha(s["story"]) if s["story"] else None,
                              "chars": len(s["story"]), "marker": s["storyMarker"],
                              "markerSeparate": s["storyMarkerSeparate"]}),
            "story_scope": "work" if plan else None,
            "story_rule": plan["story"].get("rule") if plan else None,
            "unmarked_story_candidate": s["unmarkedStoryCandidate"],
            "lyrics_hikaye_word_lines": s["lyricsHikayeWord"],
            "page_breaks_inside": s["pageBreaks"],
            "privacy_review_required": plan["privacy_review_required"] if plan else None,
            "approval_status": plan["approval_status"] if plan else PENDING,
            "integrity": "lossy" if s["issues"] else "lossless",
        })

    summary = {
        "mode": "dry-run",
        "source": str(source),
        "sourceSha256": source_hash,
        "sourceMatchesApprovedVersion": source_hash == APPROVED_SOURCE_SHA256,
        "paragraphs": len(paragraphs),
        "paragraphRoles": dict(collections.Counter(roles)),
        "markupCompatibility": markup,
        "sections": len(sections),
        "catalogWorks": len(catalog.works),
        "catalogRecordings": len(catalog.recordings),
        "worksCovered": len(by_work),
        "worksNotInSource": sorted(set(catalog.works) - set(by_work)),
        "recordingsConfirmed": len(confirmed_recs),
        "recordingsCandidate": sorted(covered_recs - confirmed_recs),
        "recordingsNotInSource": sorted(set(catalog.recordings) - covered_recs),
        "matchStatus": dict(collections.Counter(s["match"]["match_status"] for s in sections)),
        "storySourcePresent": sum(1 for s in sections if s["story"]),
        "storyMissingSections": [s["section"] for s in sections if not s["story"]],
        "unmarkedStoryCandidates": [s["section"] for s in sections if s["unmarkedStoryCandidate"]],
        "zodiacWorks": zodiac,
        "zodiacStorySha256": sha(ZODIAC_STORY),
        "pendingWorks": [w["work_id"] for w in works if w["approval_status"] == PENDING],
        "privacyReviewWorks": [w["work_id"] for w in works if w["privacy_review_required"]],
        "structuralProblems": structural,
    }
    return summary, manifest, works


def markdown(summary, manifest, works):
    out = ["# Şarkı arşivi içe aktarım manifesti (DRY-RUN)", "",
           "Bu rapor söz/hikâye metni içermez; yalnızca başlık, kimlik, durum, satır sayısı ve hash.", "",
           f"- Kaynak: `{summary['source']}`",
           f"- SHA-256: `{summary['sourceSha256']}` (onaylı sürüm: {'evet' if summary['sourceMatchesApprovedVersion'] else 'HAYIR'})",
           f"- Bölüm: {summary['sections']} · paragraf: {summary['paragraphs']} · roller: {summary['paragraphRoles']}",
           f"- Work kapsamı: {summary['worksCovered']}/{summary['catalogWorks']} · Recording: "
           f"{summary['recordingsConfirmed']} onaylı + {len(summary['recordingsCandidate'])} aday / {summary['catalogRecordings']}",
           f"- Eşleşme: {summary['matchStatus']}",
           f"- Hikâyesi olmayan bölümler: {summary['storyMissingSections']} · işaretsiz hikâye adayı: {summary['unmarkedStoryCandidates']}",
           f"- Katalog ve content/ değişmedi: {'evet' if summary.get('catalogUnchanged') else 'HAYIR'} · "
           f"kaynak değişmedi: {'evet' if summary.get('sourceUnchanged') else 'HAYIR'}", ""]
    if summary["structuralProblems"]:
        out += ["**Yapısal sorunlar**", ""] + [f"- {p}" for p in summary["structuralProblems"]] + [""]
    out += ["## Bölümler", "", "| # | Word başlığı | Work | Recording | Eşleşme | Kayıt | Söz (dolu/boş/kıta) | Söz kapsamı | "
            "Kaynak hikâye | Hikâye kuralı | Gizlilik | Durum |", "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for e in manifest:
        ls, st = e["lyrics_source"], e["story_source"]
        out.append(f"| {e['source_section']} | {e['source_title'].strip()} | {e['work_id'] or '—'} | {e['recording_id'] or '—'} | "
                   f"{e['match_status']} | {e['recording_status'] or '—'} | {ls['nonEmpty']}/{ls['blank']}/{ls['stanzas']} | "
                   f"{e['lyrics_scope'] or '—'} | {'var (' + (st['sha256'] or '')[:8] + ')' if st['present'] else 'yok'} | "
                   f"{e['story_rule'] or '—'} | {'evet' if e['privacy_review_required'] else 'hayır'} | {e['approval_status']} |")
    out += ["", "## Eserler: bekleyen kararlar", ""]
    for w in works:
        if w["pending"]:
            out.append(f"- **{w['work_id']} {w['catalogTitle']}** (bölüm {', '.join(map(str, w['sections']))}): "
                       + "; ".join(w["pending"]))
    out += ["", "## Çoklu versiyonlar", ""]
    for w in works:
        if len(w["sections"]) > 1:
            lyr = ", ".join(f"{l['target']} (bölüm {','.join(map(str, l['sections']))}, {(l['sha256'] or '')[:8]})"
                            for l in w["lyrics"])
            st = w["story"]
            out.append(f"- **{w['work_id']} {w['catalogTitle']}** — söz: {lyr}; hikâye: {st.get('rule')} "
                       f"{st['status']}, kaynaklar {[(s['section'], s['sha256'][:8]) for s in st['sources']]}")
    out += ["", "## Burç ortak hikâyesi", "",
            f"- Uygulanan metin SHA-256: `{summary['zodiacStorySha256']}` · eserler: {', '.join(summary['zodiacWorks'])}"]
    for w in works:
        if w["story"].get("rule") == "ZODIAC_SHARED" and w["story"]["sources"]:
            out.append(f"- {w['work_id']} {w['catalogTitle']}: kaynak hikâye korunuyor "
                       f"({w['story']['sources'][0]['sha256'][:8]}), uygulanan ortak metinden farklı: "
                       f"{'evet' if w['story']['sourceDiffersFromApplied'] else 'hayır'}")
    out += ["", "## Yayımlanmış içerik çakışmaları", ""]
    out += [f"- {w['work_id']} {c['file']}: kaynak {c['sourceSha256'][:8]} ≠ yayımlanan "
            f"{(c['publishedSha256'] or '?')[:8]} → {c['status']}" for w in works for c in w["conflicts"]] or ["- yok"]
    out += ["", "## Gizlilik incelemesi", ""]
    out += [f"- {w['work_id']} {w['catalogTitle']}: {', '.join(w['privacyCategories'])}"
            for w in works if w["privacy_review_required"]] or ["- yok"]
    return "\n".join(out) + "\n"


def load_privacy_review(path):
    """Repo dışındaki eser bazında gizlilik kararları ({"w-0001": "kategori"}); verilmezse boş."""
    if path is None:
        return {}
    resolved = path.resolve()
    if resolved == REPO_ROOT or REPO_ROOT in resolved.parents:
        raise InputError(f"gizlilik inceleme dosyası repo içinde olamaz (herkese açık yayımlanabilir): {resolved}")
    try:
        data = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise InputError(f"gizlilik inceleme dosyası okunamadı: {exc}")
    if not isinstance(data, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in data.items()):
        raise InputError('gizlilik inceleme dosyası {"w-0001": "kategori"} biçiminde olmalı')
    return data


def main():
    parser = argparse.ArgumentParser(description="Şarkı arşivi Word belgesini salt okunur analiz eder.")
    parser.add_argument("--source", type=Path, required=True, help="kaynak .docx")
    parser.add_argument("--dry-run", action="store_true", default=True, help="varsayılan ve tek mod")
    parser.add_argument("--catalog", type=Path, default=DATA_DIR / "catalog.json")
    parser.add_argument("--music-root", type=Path, default=None)
    parser.add_argument("--report-dir", type=Path, default=None,
                        help=f"repo dışında olmalı (varsayılan: {DEFAULT_REPORT_ROOT}/<zaman>)")
    parser.add_argument("--expect-sections", type=int, default=None, help="beklenen bölüm sayısı (ör. 68)")
    parser.add_argument("--privacy-review", type=Path, default=None,
                        help='eser bazında gizlilik kararları, {"w-0001": "kategori"} biçiminde JSON; repo dışında olmalı')
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    catalog_path = args.catalog.resolve()
    music_root = (args.music_root or catalog_path.parent.parent).resolve()
    try:
        if not args.source.is_file():
            raise InputError(f"kaynak dosya bulunamadı: {args.source}")
        privacy_review = load_privacy_review(args.privacy_review)
        report_dir = forms.choose_report_dir(
            args.report_dir or DEFAULT_REPORT_ROOT / datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
        before = forms.protected_files(catalog_path, music_root)
        source_before = hashlib.sha256(args.source.read_bytes()).hexdigest()
        summary, manifest, works = analyze(args.source, json.loads(catalog_path.read_text(encoding="utf-8")),
                                           music_root, args.expect_sections, privacy_review)
    except InputError as exc:
        print(f"HATA: {exc}", file=sys.stderr)
        sys.exit(2)
    summary["catalogUnchanged"] = forms.protected_files(catalog_path, music_root) == before
    summary["sourceUnchanged"] = hashlib.sha256(args.source.read_bytes()).hexdigest() == source_before
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "manifest.json").write_text(
        json.dumps({"summary": summary, "sections": manifest, "works": works}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8")
    (report_dir / "report.md").write_text(markdown(summary, manifest, works), encoding="utf-8")

    print(f"Kaynak: {summary['source']}  (SHA-256 {summary['sourceSha256'][:12]}…, onaylı sürüm: "
          f"{'evet' if summary['sourceMatchesApprovedVersion'] else 'HAYIR'})")
    print(f"Bölüm: {summary['sections']}  paragraf: {summary['paragraphs']}  roller: {summary['paragraphRoles']}")
    print(f"Work: {summary['worksCovered']}/{summary['catalogWorks']}  Recording: {summary['recordingsConfirmed']} onaylı"
          f" + aday {summary['recordingsCandidate']} / {summary['catalogRecordings']}")
    print(f"Eşleşme: {summary['matchStatus']}")
    print(f"Hikâyesi olmayan bölüm: {summary['storyMissingSections']}  işaretsiz aday: {summary['unmarkedStoryCandidates']}")
    print(f"Onay bekleyen eser: {len(summary['pendingWorks'])}  gizlilik incelemesi: {len(summary['privacyReviewWorks'])}")
    for problem in summary["structuralProblems"]:
        print(f"  [yapısal] {problem}")
    print(f"Katalog/content değişmedi: {'evet' if summary['catalogUnchanged'] else 'HAYIR'}  "
          f"kaynak değişmedi: {'evet' if summary['sourceUnchanged'] else 'HAYIR'}")
    print(f"Rapor: {report_dir / 'report.md'}")
    if not (summary["catalogUnchanged"] and summary["sourceUnchanged"]):
        print("HATA: korunan dosyalar çalışma sırasında değişti!", file=sys.stderr)
        sys.exit(3)
    sys.exit(1 if summary["structuralProblems"] else 0)


if __name__ == "__main__":
    main()
