#!/usr/bin/env python3
"""Ünal Büyüksungur müzik kataloğu doğrulayıcısı.

Salt okunurdur: katalog dosyalarını, web görsellerini ve kaynak arşivi yalnızca
okur, hiçbir dosya yazmaz. Python standart kütüphanesiyle çalışır; WebP
dosyalarının tam olarak açılabildiğini ve doğru kapağa ait olduğunu denetleyen
iki kontrol (23, 26) Pillow gerektirir, Pillow yoksa SKIP olarak raporlanır.

Kontroller 27-36 söz/hikâye yayınını (content/), dinleme bağlantılarını ve kalıcı
kimlikleri denetler; her sorun köşeli parantez içinde bir hata koduyla raporlanır
(ör. [CNT-PATH], [LNK-URL], [ID-BASELINE]). Kurallar: v2/music/data/README.md.

Kullanım:
    python v2/music/tools/validate_catalog.py
    python v2/music/tools/validate_catalog.py --archive ../UNAL_MUSIC_ARCHIVE

Çıkış kodu: tüm kontroller PASS ise 0, herhangi biri FAIL veya SKIP ise 1.
"""

import argparse
import hashlib
import json
import re
import struct
import sys
from pathlib import Path
from urllib.parse import urlsplit

try:
    from PIL import Image
except ImportError:  # Pillow isteğe bağlıdır; ilgili kontroller SKIP olur
    Image = None

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ARCHIVE = REPO_ROOT.parent / "UNAL_MUSIC_ARCHIVE"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
WEB_SIZES = [400, 800, 1200]
WEB_IMAGES_DIR = "images"
# Kontrol 26: küçük resim karşılaştırmasında izin verilen en yüksek ortalama fark (0-255)
THUMB_SIZE, THUMB_MAX_DIFF = 16, 12.0

# Kullanıcı tarafından onaylanmış katalog kararları (Görev 05).
# Eserler, değişmeyen kaynak kapak dosya adlarıyla tanımlanır.
ZODIAC_FILES = [
    "Koç 4.jpg",
    "Boğa 20 Nisan20 Mayıs.jpg",
    "İkizler 21 Mayıs21 Haziran.jpg",
    "Yengeç 22 Haziran22 Temmuz.jpg",
    "Aslan 23 Temmuz22 Ağustos.jpg",
    "Başak 23 Ağustos22 Eylül.jpg",
    "Terazi 23 Eylül22 Ekim.jpg",
    "Akrep 23 Ekim21 Kasım.jpg",
    "Yay 22 Kasım21 Aralık.jpg",
    "Oğlak 22 Aralık19 Ocak.jpg",
    "Kova 20 Ocak18 Şubat.jpg",
    "Balık 19 Şubat20 Mart.jpg",
]
ZODIAC_TITLES = ["Koç", "Boğa", "İkizler", "Yengeç", "Aslan", "Başak",
                 "Terazi", "Akrep", "Yay", "Oğlak", "Kova", "Balık"]
BEN_BOGAYIM_FILE = "Ben Boğa'yım.jpg"
GERMAN_FILES = ["Du bist der Grund.jpg", "Wegen Dir.jpg", "Ich meld' mich....jpg"]
SPECIAL_DAY_FILES = ["Anneler Günü.jpg", "Babalar Günü.jpg",
                     "Bugün Benim Doğum Günüm.jpg", "Mutlu Yıllar.jpg"]
# Aynı bestenin versiyonları: dosya adı -> isOriginal beklentisi. Görev 25 kullanıcı kararıyla her kayıt
# kendi bağımsız Work'ündedir (aynı Work altında olamaz); isOriginal kararları korunur.
VERSION_GROUPS = [
    {"Biliyorum.jpg": True, "Biliyorum (Rock Ballad Version).jpg": False},
    {"Turizmci.jpg": True, "Turizmci ( Pop Versiyon ).jpg": False},
    {"Yenik Yüreğim ( Pop Version ).jpg": True,
     "Yenik Yüreğim ( Thrash Metal Version ).jpg": False},
    # Ana/orijinal versiyon henüz bilinmiyor.
    {"Öyle Bir Şey.jpg": None, "Böyle Bir Şey.jpg": None},
]
# Öyle/Böyle Bir Şey: Görev 25'te iki ayrı eser, başlıkları kayıt başlıkları; ana versiyon ve tür hâlâ doğrulanmadı.
UNCONFIRMED_TITLE_GROUP = ["Öyle Bir Şey.jpg", "Böyle Bir Şey.jpg"]
ADAPTATION_PAIRS = [
    ("Du bist der Grund.jpg", "Sebebi sensin.jpg"),
    ("Ich meld' mich....jpg", "Haberleşiriz.jpg"),
    ("Wegen Dir.jpg", "Sebebi sensin.jpg"),
]
FORBIDDEN_PAIRS = [("Du bist der Grund.jpg", "Wegen Dir.jpg")]

# Kontroller 27-36: içerik yayını (Görev 09). Yollar v2/music/ köküne göredir.
CONTENT_DIR = "content"
CONTENT_FOLDERS = {"lyrics": "lyrics", "story": "stories"}
CONTENT_STATUSES = ("missing", "draft", "published")
# Görev 25: ayrılan eserler kaynak eserin söz/hikâye dosyasını paylaşır (eser -> dosyası kullanılan eser).
# Yalnızca burada listelenen eserler başka bir kimliğin dosyasına bağlanabilir.
SHARED_CONTENT = {"w-0065": "w-0014", "w-0066": "w-0020", "w-0067": "w-0056", "w-0068": "w-0061"}
# Görev 25: artık hiçbir kayda bağlı olmayan eski versiyon sözleri. Kullanıcı kararıyla silinmedi; değişmeden
# (SHA-256) content/ altında kalabilir. Silinmeleri ayrı bir karardır.
RETIRED_CONTENT = {
    "content/lyrics/r-0058.txt": "d1c2bc2df7f0369a20fc0a253e88bc13ab7029882e6b2e94a5157f03f54ca0ba",
    "content/lyrics/r-0065.txt": "cfb8a38ceebf5f30cfb637498e7ea13cbf7185e4b7cfdabe7931dd46ec87ba52",
}
# Platform anahtarı -> izin verilen ana bilgisayar adları (alt alan adları dahil)
LINK_HOSTS = {
    "spotify": ("spotify.com", "spotify.link"),
    "youtube": ("youtube.com", "youtu.be"),
    "youtubeMusic": ("music.youtube.com",),
    "appleMusic": ("music.apple.com",),
}
# Kontrol 36: kalıcı kimlikler. "rrrr:wwww" = kayıt r-rrrr, eser w-wwww, kapak c-rrrr.
# Yeni eser/kayıt eklenebilir; buradaki kimlikler silinemez, başka esere veya kapağa taşınamaz.
# Görev 05'te verildi; Görev 25 kullanıcı kararıyla dört kayıt yeni eserlere taşındı:
# r-0014 -> w-0065, r-0021 -> w-0066, r-0058 -> w-0067, r-0065 -> w-0068.
ID_BASELINE = (
    "0001:0001 0002:0002 0003:0003 0004:0004 0005:0005 0006:0006 0007:0007 0008:0008 0009:0009 0010:0010 "
    "0011:0011 0012:0012 0013:0013 0014:0065 0015:0014 0016:0015 0017:0016 0018:0017 0019:0018 0020:0019 "
    "0021:0066 0022:0021 0023:0022 0024:0023 0025:0024 0026:0025 0027:0026 0028:0027 0029:0028 0030:0029 "
    "0031:0030 0032:0031 0033:0032 0034:0033 0035:0034 0036:0035 0037:0036 0038:0037 0039:0038 0040:0039 "
    "0041:0040 0042:0041 0043:0042 0044:0043 0045:0044 0046:0045 0047:0046 0048:0047 0049:0048 0050:0049 "
    "0051:0020 0052:0050 0053:0051 0054:0052 0055:0053 0056:0054 0057:0055 0058:0067 0059:0056 0060:0057 "
    "0061:0058 0062:0059 0063:0060 0064:0061 0065:0068 0066:0062 0067:0063 0068:0064"
)
BASELINE_WORK_COUNT = 68


# --- Dosya yardımcıları ------------------------------------------------------

def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_image_info(path):
    """(format, width, height) döndürür; yalnızca dosya başlığını okur."""
    with open(path, "rb") as handle:
        head = handle.read(24)
        if head.startswith(b"\x89PNG\r\n\x1a\n"):
            width, height = struct.unpack(">II", head[16:24])
            return "png", width, height
        if not head.startswith(b"\xff\xd8"):
            return "unknown", None, None
        handle.seek(2)
        while True:
            byte = handle.read(1)
            if not byte:
                return "jpeg", None, None
            if byte != b"\xff":
                continue
            marker = handle.read(1)
            while marker == b"\xff":
                marker = handle.read(1)
            code = marker[0] if marker else 0
            if code in (0xD8, 0x01) or 0xD0 <= code <= 0xD7:
                continue
            (length,) = struct.unpack(">H", handle.read(2))
            if code in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                        0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                height, width = struct.unpack(">xHH", handle.read(5))
                return "jpeg", width, height
            handle.seek(length - 2, 1)


def read_webp_info(path):
    """(geçerli_mi, width, height) döndürür; RIFF/VP8 başlığını standart kütüphaneyle okur."""
    data = path.read_bytes()
    if len(data) < 30 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return False, None, None
    if struct.unpack("<I", data[4:8])[0] + 8 != len(data):
        return False, None, None
    chunk, body = data[12:16], data[20:]
    if chunk == b"VP8 " and body[3:6] == b"\x9d\x01\x2a":
        width, height = struct.unpack("<HH", body[6:10])
        return True, width & 0x3FFF, height & 0x3FFF
    if chunk == b"VP8L" and body[0] == 0x2F:
        bits = int.from_bytes(body[1:5], "little")
        return True, (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8X":
        return (True, int.from_bytes(body[4:7], "little") + 1,
                int.from_bytes(body[7:10], "little") + 1)
    return False, None, None


def thumbnail(path):
    """Kapak eşleştirmesi için küçük gri tonlu özet (Pillow gerekir)."""
    with Image.open(path) as image:
        image.draft("RGB", (THUMB_SIZE * 8, THUMB_SIZE * 8))  # JPEG için hızlı ön küçültme
        small = image.convert("L").resize((THUMB_SIZE, THUMB_SIZE), Image.Resampling.BOX)
        flatten = getattr(small, "get_flattened_data", small.getdata)  # Pillow 14'te getdata kalkıyor
        return list(flatten())


def list_archive_covers(archive):
    covers_dir = archive / "covers"
    return sorted(p.name for p in covers_dir.iterdir()
                  if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS)


def content_entries(works, recordings):
    """(sahip kimliği, alan, içerik) üçlüleri: eser sözleri ve hikâyesi, kayıtların isteğe bağlı söz istisnası."""
    for work in works.values():
        for field in CONTENT_FOLDERS:
            yield work["id"], field, work.get(field)
    for recording in recordings.values():
        if "lyrics" in recording:
            yield recording["id"], "lyrics", recording["lyrics"]


def expected_content_path(owner, field):
    return f"{CONTENT_DIR}/{CONTENT_FOLDERS[field]}/{SHARED_CONTENT.get(owner, owner)}.txt"


def url_problem(url, hosts=None):
    """Geçerli bir HTTPS dinleme bağlantısı değilse sorunu, geçerliyse None döndürür."""
    if not isinstance(url, str) or not url:
        return "metin değil"
    if any(ch.isspace() or ord(ch) < 32 for ch in url):
        return "boşluk/kontrol karakteri içeriyor"
    parts = urlsplit(url)
    if parts.scheme != "https":
        return "https değil"
    if not parts.hostname or "." not in parts.hostname:
        return "geçerli bir ana bilgisayar adı yok"
    if parts.username or parts.password:
        return "kullanıcı bilgisi içeriyor"
    host = parts.hostname.lower()
    if hosts and not any(host == h or host.endswith("." + h) for h in hosts):
        return f"{host} bu platforma ait değil ({', '.join(hosts)})"
    return None


# --- Basit JSON Schema alt kümesi ---------------------------------------------
# Desteklenen anahtar kelimeler: $ref, type, enum, pattern, minimum, required,
# properties, additionalProperties, items. schema.json yalnızca bunları kullanır.

TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def schema_errors(value, schema, root, path="$"):
    if "$ref" in schema:
        name = schema["$ref"].split("/")[-1]
        return schema_errors(value, root["$defs"][name], root, path)
    errors = []
    types = schema.get("type")
    if types is not None:
        types = [types] if isinstance(types, str) else types
        if not any(TYPE_CHECKS[t](value) for t in types):
            return [f"{path}: tür {types} bekleniyordu"]
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: {value!r} izin verilen değerlerden değil")
    if isinstance(value, str) and "pattern" in schema:
        if not re.search(schema["pattern"], value):
            errors.append(f"{path}: {value!r} kalıba uymuyor")
    if isinstance(value, int) and "minimum" in schema and value < schema["minimum"]:
        errors.append(f"{path}: {value} < {schema['minimum']}")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: zorunlu alan eksik: {key}")
        props = schema.get("properties", {})
        for key, item in value.items():
            if key in props:
                errors.extend(schema_errors(item, props[key], root, f"{path}.{key}"))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}: tanımsız alan: {key}")
    if isinstance(value, list) and "items" in schema:
        for index, item in enumerate(value):
            errors.extend(schema_errors(item, schema["items"], root, f"{path}[{index}]"))
    return errors


# --- Kontroller --------------------------------------------------------------

class Report:
    def __init__(self):
        self.results = []

    def check(self, code, label, problems, skipped=False):
        status = "SKIP" if skipped else ("FAIL" if problems else "PASS")
        self.results.append((code, label, status, list(problems)))

    def print(self):
        for code, label, status, problems in self.results:
            print(f"[{status}] {code:>2}. {label}")
            for problem in problems[:20]:
                print(f"         - {problem}")
            if len(problems) > 20:
                print(f"         - ... (+{len(problems) - 20})")
        counts = {s: sum(1 for r in self.results if r[2] == s) for s in ("PASS", "FAIL", "SKIP")}
        print()
        print(f"Toplam: {len(self.results)} kontrol, {counts['PASS']} PASS, "
              f"{counts['FAIL']} FAIL, {counts['SKIP']} SKIP")
        return counts["PASS"] == len(self.results)


def run(catalog, schema, archive, music_root):
    report = Report()
    works = {w["id"]: w for w in catalog.get("works", [])}
    recordings = {r["id"]: r for r in catalog.get("recordings", [])}
    covers = {c["id"]: c for c in catalog.get("covers", [])}
    collections = catalog.get("collections", [])
    relations = catalog.get("relations", [])

    report.check("S", "Katalog şemaya uygun (schema.json)",
                 schema_errors(catalog, schema, schema))

    cover_by_file = {}
    for cover in catalog.get("covers", []):
        cover_by_file.setdefault(cover["sourceFileName"], []).append(cover)
    recording_by_cover = {}
    for recording in recordings.values():
        recording_by_cover.setdefault(recording["coverId"], []).append(recording)

    def work_for_file(name):
        cover = cover_by_file.get(name, [None])[0]
        recs = recording_by_cover.get(cover["id"], []) if cover else []
        return works.get(recs[0]["workId"]) if recs else None

    def recording_for_file(name):
        cover = cover_by_file.get(name, [None])[0]
        recs = recording_by_cover.get(cover["id"], []) if cover else []
        return recs[0] if recs else None

    # 1-2. Kaynak arşiv kapsamı
    archive_files = list_archive_covers(archive)
    problems = []
    if len(archive_files) != 68:
        problems.append(f"arşivde {len(archive_files)} kapak var, 68 bekleniyordu")
    for name in archive_files:
        count = len(cover_by_file.get(name, []))
        if count != 1:
            problems.append(f"{name!r} katalogda {count} kez temsil ediliyor")
    report.check(1, "68 kapağın her biri katalogda tam bir kez temsil ediliyor", problems)

    archive_set = set(archive_files)
    report.check(2, "Kaynakta bulunmayan kapak referansı yok",
                 [f"{name!r} arşivde yok" for name in cover_by_file
                  if name not in archive_set])

    # 3. Kimlik çakışmaları (tüm varlık türlerinde global)
    seen, problems = {}, []
    for kind in ("works", "recordings", "covers", "collections", "relations", "openIssues"):
        for item in catalog.get(kind, []):
            if item["id"] in seen:
                problems.append(f"{item['id']} hem {seen[item['id']]} hem {kind} içinde")
            seen[item["id"]] = kind
    report.check(3, "Work / Recording / CoverAsset (ve diğer) ID çakışması yok", problems)

    # 4. Slug benzersizliği
    problems, slugs = [], {}
    for work in works.values():
        slug = work.get("slug")
        if slug is None:
            if work.get("titleStatus") != "unconfirmed":
                problems.append(f"{work['id']}: slug yalnızca başlığı doğrulanmamış eserde boş olabilir")
            continue
        if slug in slugs:
            problems.append(f"slug {slug!r}: {slugs[slug]} ve {work['id']}")
        slugs[slug] = work["id"]
    report.check(4, "Work slug'ları benzersiz", problems)

    # 5. Recording -> Work (ve -> Cover) ilişkileri
    problems = []
    for recording in recordings.values():
        if recording["workId"] not in works:
            problems.append(f"{recording['id']}: bilinmeyen workId {recording['workId']}")
        if recording["coverId"] not in covers:
            problems.append(f"{recording['id']}: bilinmeyen coverId {recording['coverId']}")
    used_works = {r["workId"] for r in recordings.values()}
    problems += [f"{wid}: hiç kaydı yok" for wid in works if wid not in used_works]
    problems += [f"{cid}: {len(recording_by_cover.get(cid, []))} kayıtta kullanılıyor (1 bekleniyordu)"
                 for cid in covers if len(recording_by_cover.get(cid, [])) != 1]
    report.check(5, "Recording → Work (ve Recording → CoverAsset) ilişkileri geçerli", problems)

    # 6. Collection -> Work
    problems = []
    for collection in collections:
        member_ids = [m["workId"] for m in collection["members"]]
        problems += [f"{collection['id']}: bilinmeyen workId {wid}"
                     for wid in member_ids if wid not in works]
        if len(member_ids) != len(set(member_ids)):
            problems.append(f"{collection['id']}: tekrarlanan üye")
    report.check(6, "Collection → Work ilişkileri geçerli", problems)

    # 7. RelatedWork referansları ve onaylı uyarlama kararları
    problems = []
    pairs = []
    for relation in relations:
        for side in ("source", "target"):
            if relation[side] not in works:
                problems.append(f"{relation['id']}: bilinmeyen {side} {relation[side]}")
        pairs.append(frozenset((relation["source"], relation["target"])))

    def pair_for(file_a, file_b):
        a, b = work_for_file(file_a), work_for_file(file_b)
        return frozenset((a["id"], b["id"])) if a and b else None

    for file_a, file_b in ADAPTATION_PAIRS:
        pair = pair_for(file_a, file_b)
        matching = [r for r in relations
                    if frozenset((r["source"], r["target"])) == pair]
        if not matching:
            problems.append(f"eksik uyarlama ilişkisi: {file_a} ↔ {file_b}")
        elif matching[0]["type"] != "adaptation" or matching[0]["status"] != "verified":
            problems.append(f"{matching[0]['id']}: type/status adaptation/verified olmalı")
    for file_a, file_b in FORBIDDEN_PAIRS:
        if pair_for(file_a, file_b) in pairs:
            problems.append(f"doğrulanmamış doğrudan ilişki var: {file_a} ↔ {file_b}")
    for file_a, file_b in ADAPTATION_PAIRS:
        a, b = work_for_file(file_a), work_for_file(file_b)
        if a and b and a["id"] == b["id"]:
            problems.append(f"dil uyarlamaları tek Work altında birleştirilmiş: {a['id']}")
    report.check(7, "RelatedWork ilişkileri geçerli (onaylı 3 uyarlama, yasak ilişki yok)", problems)

    # 8. Kendine referans / tekrar
    problems = [f"{r['id']}: kendine referans" for r in relations
                if r["source"] == r["target"]]
    duplicates = {p for p in pairs if pairs.count(p) > 1}
    problems += [f"tekrarlanan ilişki: {sorted(p)}" for p in duplicates]
    report.check(8, "İlişkilerde kendine referans veya tekrar yok", problems)

    by_slug = {c["slug"]: c for c in collections}

    def member_ids(slug):
        collection = by_slug.get(slug)
        return [m["workId"] for m in collection["members"]] if collection else []

    # 9. Burç koleksiyonu
    problems = []
    zodiac = member_ids("burc-serisi")
    if len(zodiac) != 12:
        problems.append(f"burç koleksiyonunda {len(zodiac)} eser var")
    expected = [work_for_file(name) for name in ZODIAC_FILES]
    if [w["id"] if w else None for w in expected] != zodiac:
        problems.append("burç üyeleri/sırası beklenen 12 kapakla eşleşmiyor")
    titles = [works[wid]["title"] for wid in zodiac if wid in works]
    if titles != ZODIAC_TITLES:
        problems.append(f"burç başlıkları yalnızca burç adı olmalı: {titles}")
    for member in by_slug.get("burc-serisi", {}).get("members", []):
        if "dateRange" not in member:
            problems.append(f"{member['workId']}: dateRange alanı eksik")
    report.check(9, "Burç koleksiyonunda tam 12 eser var", problems)

    # 10. Ben Boğa'yım
    ben = work_for_file(BEN_BOGAYIM_FILE)
    problems = []
    if not ben:
        problems.append("Ben Boğa'yım eseri bulunamadı")
    elif ben["id"] in zodiac:
        problems.append("Ben Boğa'yım burç koleksiyonunda")
    report.check(10, "Ben Boğa'yım burç koleksiyonunda değil (bağımsız eser)", problems)

    # 11. Almanca koleksiyon
    problems = []
    german = member_ids("almanca-sarkilar")
    for name in GERMAN_FILES:
        work = work_for_file(name)
        if not work or work["id"] not in german:
            problems.append(f"{name} Almanca koleksiyonunda değil")
        elif work["language"] != "de":
            problems.append(f"{name}: language 'de' olmalı")
    if len(german) != len(GERMAN_FILES):
        problems.append(f"Almanca koleksiyonunda {len(german)} eser var")
    report.check(11, "Üç Almanca eser Almanca koleksiyonunda", problems)

    # 12. Özel gün koleksiyonu
    problems = []
    special = member_ids("ozel-gun-sarkilari")
    for name in SPECIAL_DAY_FILES:
        work = work_for_file(name)
        if not work or work["id"] not in special:
            problems.append(f"{name} özel gün koleksiyonunda değil")
    if len(special) != len(SPECIAL_DAY_FILES):
        problems.append(f"özel gün koleksiyonunda {len(special)} eser var")
    report.check(12, "Dört özel gün eseri ilgili koleksiyonda", problems)

    # 13. İlk/orijinal versiyon kararları
    problems = []
    for group in VERSION_GROUPS:
        group_works = [(work_for_file(name) or {}).get("id") for name in group]
        if len(set(group_works)) != len(group) or None in group_works:
            problems.append(f"her versiyon ayrı Work'te olmalı (Görev 25): {sorted(group)}")
        for work_id in sorted(set(filter(None, group_works))):
            count = sum(1 for r in recordings.values() if r["workId"] == work_id)
            if count != 1:
                problems.append(f"{work_id}: {count} kayıt (ayrılan eserde tam 1 olmalı)")
        for name, expected_flag in group.items():
            recording = recording_for_file(name)
            if recording is None or recording["isOriginal"] is not expected_flag:
                problems.append(f"{name}: isOriginal {expected_flag} olmalı")
    for work_id in works:
        originals = [r for r in recordings.values()
                     if r["workId"] == work_id and r["isOriginal"] is True]
        if len(originals) > 1:
            problems.append(f"{work_id}: birden fazla orijinal kayıt")
    report.check(13, "İlk/orijinal versiyon kararları doğru", problems)

    # 14. Öyle / Böyle Bir Şey
    problems = []
    for name in UNCONFIRMED_TITLE_GROUP:
        work, recording = work_for_file(name), recording_for_file(name)
        if work and recording and work.get("title") != recording["title"]:
            problems.append(f"{name}: eser başlığı kayıt başlığıyla aynı olmalı (Görev 25 kararı)")
        if recording and recording["isOriginal"] is not None:
            problems.append(f"{name}: doğrulanmamış ana versiyon atanmış")
        if recording and recording["genres"]:
            problems.append(f"{name}: doğrulanmamış tür atanmış")
    report.check(14, "Öyle/Böyle Bir Şey ayrı eserler; doğrulanmamış ana versiyon veya tür atanmadı", problems)

    # 15. Uydurma veri yok: içeriği olmayan söz/hikâye bir dosyaya bağlanmamış.
    # (Yayımlanan dosyaların yolu, varlığı ve içeriği 27-33'te denetlenir.)
    problems = []
    for owner, field, entry in content_entries(works, recordings):
        if isinstance(entry, dict) and entry.get("status") == "missing" and entry.get("file") is not None:
            problems.append(f"{owner}.{field}: missing ama dosya belirtilmiş")
    report.check(15, "Bilinmeyen tarih/bağlantı/söz/hikâye uydurulmadı", problems)

    # 16. Kaynak dosya adları ve içerik birebir
    problems, source_sha = [], {}
    for cover in covers.values():
        path = archive / "covers" / cover["sourceFileName"]
        if not path.is_file():
            continue  # kontrol 2'de raporlanır
        fmt, width, height = read_image_info(path)
        if (fmt, width, height) != (cover["format"], cover["width"], cover["height"]):
            problems.append(f"{cover['id']}: format/çözünürlük uyuşmuyor")
        if path.stat().st_size != cover["bytes"]:
            problems.append(f"{cover['id']}: dosya boyutu uyuşmuyor")
        source_sha[cover["id"]] = sha256_file(path)
        if source_sha[cover["id"]] != cover["sha256"]:
            problems.append(f"{cover['id']}: sha256 uyuşmuyor")
    report.check(16, "Kaynak dosya adları, hash ve çözünürlükler birebir korunuyor", problems)

    # 17-26. Web görselleri (webImages)
    web = [(cover, item) for cover in covers.values() for item in cover.get("webImages", [])]

    def web_path(item):
        return music_root / item["path"]

    problems = []
    for cover in covers.values():
        widths = sorted(item["width"] for item in cover.get("webImages", []))
        if widths != WEB_SIZES:
            problems.append(f"{cover['id']}: webImages genişlikleri {widths}, beklenen {WEB_SIZES}")
    report.check(17, f"Her CoverAsset için üç WebP yolu var ({'/'.join(map(str, WEB_SIZES))})", problems)

    paths = [item["path"] for _, item in web]
    expected_total = len(WEB_SIZES) * len(covers)
    problems = []
    if len(paths) != expected_total:
        problems.append(f"{len(paths)} referans var, {expected_total} bekleniyordu")
    problems += [f"tekrarlanan yol: {p}" for p in sorted(set(paths)) if paths.count(p) > 1]
    report.check(18, f"Toplam {expected_total} benzersiz WebP referansı var", problems)

    problems, present = [], []
    for cover, item in web:
        path = web_path(item)
        if not path.is_file():
            problems.append(f"{cover['id']}: dosya yok: {item['path']}")
            continue
        present.append((cover, item))
        if path.stat().st_size != item["bytes"]:
            problems.append(f"{item['path']}: boyut katalogla uyuşmuyor")
        elif sha256_file(path) != item["sha256"]:
            problems.append(f"{item['path']}: sha256 katalogla uyuşmuyor")
    report.check(19, "Referans verilen tüm WebP dosyaları mevcut (boyut ve SHA-256 katalogla eşleşiyor)",
                 problems)

    problems, headers = [], {}
    for cover, item in present:
        valid, width, height = read_webp_info(web_path(item))
        headers[item["path"]] = (width, height)
        if not valid:
            problems.append(f"{item['path']}: geçerli bir RIFF/WebP dosyası değil")
    report.check(20, "Dosyaların tamamı gerçek WebP formatında (RIFF/VP8 başlığı)", problems)

    problems = []
    for cover, item in present:
        actual = headers.get(item["path"])
        expected = (item["width"], item["width"])
        if (item["width"], item["height"]) != expected or actual != expected:
            problems.append(f"{item['path']}: katalog {item['width']}x{item['height']}, dosya {actual}")
    report.check(21, "Görsel çözünürlükleri doğru ve kare", problems)

    problems = []
    for cover, item in web:
        expected = f"{WEB_IMAGES_DIR}/{cover['id']}-{item['width']}.webp"
        if item["path"] != expected:
            problems.append(f"{cover['id']}: {item['path']} (beklenen {expected})")
    report.check(22, "Dosya adları doğru CoverAsset ID'sine ve çözünürlüğe bağlı", problems)

    problems = []
    if Image is not None:
        for cover, item in present:
            try:
                with Image.open(web_path(item)) as image:
                    image.load()
                    if image.format != "WEBP" or "A" in image.getbands():
                        problems.append(f"{item['path']}: {image.format} {image.mode}")
            except Exception as exc:  # noqa: BLE001 — her açılma hatası raporlanır
                problems.append(f"{item['path']}: açılamadı ({exc})")
    report.check(23, "Her WebP dosyası açılabiliyor (tam çözümleme, alfa kanalı yok)", problems,
                 skipped=Image is None)

    report.check(24, "Kaynak SHA-256 değerleri değişmemiş",
                 [f"{cid}: kaynak sha256 değişmiş" for cid, digest in source_sha.items()
                  if digest != covers[cid]["sha256"]]
                 + [f"{c['id']}: kaynak dosya okunamadı" for c in covers.values()
                    if c["id"] not in source_sha])

    images_dir = music_root / WEB_IMAGES_DIR
    problems = []
    if images_dir.is_dir():
        referenced = {Path(p).name for p in paths}
        for entry in sorted(images_dir.iterdir()):
            if not entry.is_file() or entry.name not in referenced:
                problems.append(f"beklenmeyen öğe: {WEB_IMAGES_DIR}/{entry.name}")
    elif paths:
        problems.append(f"{WEB_IMAGES_DIR}/ klasörü yok")
    report.check(25, "Üretim klasöründe beklenmeyen dosya yok", problems)

    problems, worst = [], 0.0
    if Image is not None:
        source_thumbs = {}
        for cover in covers.values():
            path = archive / "covers" / cover["sourceFileName"]
            if path.is_file():
                source_thumbs[cover["id"]] = thumbnail(path)

        def diff(a, b):
            return sum(abs(x - y) for x, y in zip(a, b)) / len(a)

        for cover, item in present:
            try:
                thumb = thumbnail(web_path(item))
            except Exception:  # noqa: BLE001 — kontrol 23'te raporlanır
                continue
            scores = {cid: diff(thumb, t) for cid, t in source_thumbs.items()}
            nearest = min(scores, key=scores.get)
            own = scores.get(cover["id"])
            worst = max(worst, own or 0.0)
            if nearest != cover["id"]:
                problems.append(f"{item['path']}: en çok {nearest} kaynağına benziyor")
            elif own > THUMB_MAX_DIFF:
                problems.append(f"{item['path']}: kendi kaynağından fark {own:.1f} > {THUMB_MAX_DIFF}")
    report.check(26, f"Çözünürlükler arasında yanlış görsel eşleşmesi yok "
                     f"(en büyük fark {worst:.2f}/255, sınır {THUMB_MAX_DIFF})",
                 problems, skipped=Image is None)

    # 27-33. Söz ve hikâye yayını. Hata kodları: CNT-STATUS, CNT-NOFILE, CNT-MISSING,
    # CNT-PATH, CNT-UTF8, CNT-EMPTY, CNT-DRAFT.
    entries = list(content_entries(works, recordings))
    content_root = (music_root / CONTENT_DIR).resolve()

    problems = []
    for owner, field, entry in entries:
        if not isinstance(entry, dict) or entry.get("status") not in CONTENT_STATUSES:
            problems.append(f"[CNT-STATUS] {owner}.{field}: geçersiz durum {entry!r} "
                            f"(izin verilen: {', '.join(CONTENT_STATUSES)})")
    report.check(27, "İçerik durumları geçerli (missing / draft / published)", problems)
    entries = [(o, f, e) for o, f, e in entries if isinstance(e, dict) and e.get("status") in CONTENT_STATUSES]
    published = [(o, f, e) for o, f, e in entries if e["status"] == "published"]

    report.check(28, "Yayımlanmış (published) içeriğin dosya yolu var",
                 [f"[CNT-NOFILE] {o}.{f}: published ama file boş" for o, f, e in published
                  if not isinstance(e.get("file"), str) or not e["file"]])

    problems, safe = [], []
    for owner, field, entry in entries:
        file = entry.get("file")
        if not isinstance(file, str) or not file:
            continue
        expected = expected_content_path(owner, field)
        if file != expected:
            problems.append(f"[CNT-PATH] {owner}.{field}: {file!r} kabul edilmez, beklenen {expected!r} "
                            "(göreli, content/ altında, kimlikle adlandırılmış)")
            continue
        resolved = (music_root / file).resolve()
        if not resolved.is_relative_to(content_root / CONTENT_FOLDERS[field]):
            problems.append(f"[CNT-PATH] {owner}.{field}: {file!r} izin verilen klasörün dışına çıkıyor")
            continue
        safe.append((owner, field, entry, resolved))
    path_problems = problems

    published_safe = [(o, f, e, p) for o, f, e, p in safe if e["status"] == "published"]
    report.check(29, "Yayımlanmış içerik dosyaları gerçekten mevcut",
                 [f"[CNT-MISSING] {o}.{f}: dosya yok: {e['file']}" for o, f, e, p in published_safe
                  if not p.is_file()])
    report.check(30, "İçerik yolları izin verilen klasörde ve kimlikle adlandırılmış "
                     "(mutlak yol, URL, ../ yok)", path_problems)

    problems, texts = [], {}
    for owner, field, entry, path in published_safe:
        if not path.is_file():
            continue
        data = path.read_bytes()
        if data.startswith(b"\xef\xbb\xbf"):
            problems.append(f"[CNT-UTF8] {entry['file']}: UTF-8 BOM içeriyor (BOM'suz UTF-8 olmalı)")
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            problems.append(f"[CNT-UTF8] {entry['file']}: geçerli UTF-8 değil ({exc.reason}, bayt {exc.start})")
            continue
        bad = sorted({f"U+{ord(ch):04X}" for ch in text if ord(ch) < 32 and ch not in "\n\r\t"})
        if bad:
            problems.append(f"[CNT-UTF8] {entry['file']}: kontrol karakteri içeriyor ({', '.join(bad)})")
            continue
        texts[entry["file"]] = text
    report.check(31, "Yayımlanmış içerik dosyaları UTF-8 düz metin olarak okunabiliyor", problems)

    report.check(32, "Yayımlanmış içerik boş değil",
                 [f"[CNT-EMPTY] {file}: dosyada metin yok" for file, text in texts.items() if not text.strip()])

    problems = [f"[CNT-DRAFT] {o}.{f}: draft içerik herkese açık bir dosyaya bağlanmış ({e['file']!r}); "
                "taslak metinler content/ altında tutulmaz" for o, f, e in entries
                if e["status"] == "draft" and e.get("file") is not None]
    referenced = {p for _, _, e, p in published_safe}
    if content_root.exists():
        for path in sorted(content_root.rglob("*")):
            if path.is_dir():
                if path.parent == content_root and path.name in CONTENT_FOLDERS.values():
                    continue
                problems.append(f"[CNT-DRAFT] beklenmeyen klasör: {path.relative_to(music_root).as_posix()}")
            elif path.resolve() not in referenced:
                retired = RETIRED_CONTENT.get(path.relative_to(music_root).as_posix())
                if retired and sha256_file(path) == retired:
                    continue  # Görev 25: silinmemiş, değişmemiş eski versiyon sözü (yayımlanmıyor)
                problems.append(f"[CNT-DRAFT] yayımlanmış bir içeriğe ait olmayan dosya herkese açık klasörde: "
                                f"{path.relative_to(music_root).as_posix()}")
    report.check(33, "Taslak içerik herkese açık dosya yoluna bağlı değil (content/ yalnızca yayımlanmış dosyaları içerir)",
                 problems)

    # 34-35. Dinleme bağlantıları (Recording düzeyinde). Hata kodları: LNK-URL, LNK-REC.
    problems, owners = [], {}
    for recording in recordings.values():
        links = recording.get("links", {})
        found = [(key, links.get(key), LINK_HOSTS[key]) for key in LINK_HOSTS if links.get(key) is not None]
        for index, item in enumerate(links.get("other", [])):
            if not isinstance(item, dict) or not str(item.get("platform", "")).strip():
                problems.append(f"[LNK-URL] {recording['id']}.links.other[{index}]: platform adı eksik")
            found.append((f"other[{index}]", item.get("url") if isinstance(item, dict) else None, None))
        for key, url, hosts in found:
            problem = url_problem(url, hosts)
            if problem:
                problems.append(f"[LNK-URL] {recording['id']}.links.{key}: {url!r} — {problem}")
            else:
                owners.setdefault(url, []).append(recording["id"])
    report.check(34, "Dinleme bağlantıları yalnızca geçerli HTTPS adresleri (doğru platform alan adı)", problems)

    problems = []
    for url, owner_ids in owners.items():
        if len(owner_ids) > 1:
            problems.append(f"[LNK-REC] {url}: birden fazla kayda bağlı ({', '.join(owner_ids)}); "
                            "her versiyonun kendi bağlantısı olmalı")
    for recording_id in sorted({rid for ids in owners.values() for rid in ids}):
        recording = recordings[recording_id]
        if recording["workId"] not in works or recording["coverId"] not in covers:
            problems.append(f"[LNK-REC] {recording_id}: bağlantılı kaydın eser/kapak ilişkisi geçersiz")
    report.check(35, "Dinleme bağlantılarının Recording ilişkisi geçerli (her bağlantı tek bir kayda ait)", problems)

    # 36. Kalıcı kimlikler. Hata kodu: ID-BASELINE.
    problems = []
    for pair in ID_BASELINE.split():
        number, work_number = pair.split(":")
        rid, wid, cid = f"r-{number}", f"w-{work_number}", f"c-{number}"
        recording = recordings.get(rid)
        if recording is None:
            problems.append(f"[ID-BASELINE] {rid} silinmiş veya yeniden adlandırılmış")
        elif (recording["workId"], recording["coverId"]) != (wid, cid):
            problems.append(f"[ID-BASELINE] {rid}: {wid}/{cid} olmalı, "
                            f"{recording['workId']}/{recording['coverId']} bulundu")
    for number in range(1, BASELINE_WORK_COUNT + 1):
        if f"w-{number:04d}" not in works:
            problems.append(f"[ID-BASELINE] w-{number:04d} silinmiş veya yeniden adlandırılmış")
    report.check(36, f"Mevcut {BASELINE_WORK_COUNT} Work ve {len(ID_BASELINE.split())} Recording kimliği "
                     "korunuyor", problems)

    # Bilgi amaçlı özet
    print(f"Katalog: {len(works)} Work, {len(recordings)} Recording, "
          f"{len(covers)} CoverAsset, {len(collections)} Collection, "
          f"{len(relations)} RelatedWork, {len(catalog.get('openIssues', []))} açık konu")
    known_dates = sum(1 for r in recordings.values() if r["releaseDate"])
    known_links = sum(1 for r in recordings.values()
                      for key, value in r["links"].items() if value and key != "other")
    known_links += sum(len(r["links"]["other"]) for r in recordings.values())
    known_lyrics = sum(1 for w in works.values() if w["lyrics"]["status"] != "missing")
    known_stories = sum(1 for w in works.values() if w["story"]["status"] != "missing")
    print(f"Bilinen değerler: {known_dates} yayın tarihi, {known_links} platform bağlantısı, "
          f"{known_lyrics} söz, {known_stories} hikâye")
    print()
    return report.print()


def main():
    parser = argparse.ArgumentParser(description="Müzik kataloğunu salt okunur doğrular.")
    parser.add_argument("--catalog", type=Path, default=DATA_DIR / "catalog.json")
    parser.add_argument("--schema", type=Path, default=DATA_DIR / "schema.json")
    parser.add_argument("--archive", type=Path, default=DEFAULT_ARCHIVE)
    parser.add_argument("--music-root", type=Path, default=None,
                        help="webImages yollarının göreli olduğu klasör (varsayılan: katalogun iki üstü)")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    schema = json.loads(args.schema.read_text(encoding="utf-8"))
    music_root = args.music_root or args.catalog.resolve().parent.parent
    sys.exit(0 if run(catalog, schema, args.archive, music_root) else 1)


if __name__ == "__main__":
    main()
