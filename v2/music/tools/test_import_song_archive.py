#!/usr/bin/env python3
"""import_song_archive.py için sentetik testler (standart kütüphane unittest).

Gerçek arşiv belgesi ve gerçek hikâyeler kullanılmaz: her test, arşiv belgesinin yapısını
(Word otomatik numaralı başlıklar, söz paragrafları, "Hikayesi:" satırları) taklit eden DOCX
dosyalarını geçici bir klasörde üretir. Katalog yalnızca okunur; testlerin başında ve sonunda
catalog.json, schema.json ve content/ dosyalarının SHA-256 değerleri karşılaştırılır.

Kullanım:
    python v2/music/tools/test_import_song_archive.py
"""

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

sys.dont_write_bytecode = True  # v2/ altında __pycache__ oluşmasın (herkese açık klasör)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import import_song_archive as isa  # noqa: E402

TOOL = Path(isa.__file__).resolve()
CATALOG_PATH = isa.DATA_DIR / "catalog.json"
CATALOG = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
MUSIC_ROOT = isa.MUSIC_ROOT

# Görev 25'te ayrılan eserler: (kaynak eser, ayrılan kayıt, yeni eser). Canlı katalogda her eserin tek kaydı var;
# aracın çok versiyonlu eser desteği bu çiftler bellekteki kopyada geri birleştirilerek (Görev 25 öncesi yapı) sınanır.
SPLIT_WORKS = [("w-0014", "r-0014", "w-0065"), ("w-0020", "r-0021", "w-0066"),
               ("w-0056", "r-0058", "w-0067"), ("w-0061", "r-0065", "w-0068")]
VERSION_LYRICS = {"r-0058": "content/lyrics/r-0058.txt", "r-0065": "content/lyrics/r-0065.txt"}


def merge_split_works(data):
    """Ayrılan eser çiftlerini tek esere geri birleştirir; canlı katalog dosyasına dokunmaz."""
    data = json.loads(json.dumps(data))
    new_ids = {new for _, _, new in SPLIT_WORKS}
    data["works"] = [w for w in data["works"] if w["id"] not in new_ids]
    for source, recording_id, _new in SPLIT_WORKS:
        recording = next(r for r in data["recordings"] if r["id"] == recording_id)
        recording["workId"] = source
        if recording_id in VERSION_LYRICS:
            recording["lyrics"] = {"status": "published", "file": VERSION_LYRICS[recording_id]}
    next(w for w in data["works"] if w["id"] == "w-0020").update(
        title=None, titleStatus="unconfirmed", workingTitle="Öyle Bir Şey / Böyle Bir Şey", slug=None)
    return data


# Görev 14 kararları (APPROVED_MATCHES, ortak hikâyeler) birleşik eser modeline göredir; analiz testleri bu modelle çalışır.
MERGED_CATALOG = merge_split_works(CATALOG)
ZODIAC_TITLES = ["Koç", "Boğa", "İkizler", "Yengeç", "Aslan", "Başak",
                 "Terazi", "Akrep", "Yay", "Oğlak", "Kova", "Balık"]

DOC_HEAD = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
            'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
            'xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex"><w:body>')
DOC_TAIL = "<w:sectPr/></w:body></w:document>"


def run(text):
    return f'<w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r>' if text else ""


def para(text="", inner=""):
    return f"<w:p>{run(text)}{inner}</w:p>"


def title(text):
    return ('<w:p><w:pPr><w:pStyle w:val="ListeParagraf"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/>'
            f"</w:numPr></w:pPr>{run(text)}</w:p>")


def section(name, lyrics=("Birinci satır", "İkinci satır"), story=None, blank_after=2):
    """story: None (hikâye yok), metin ("Hikayesi: …" satırı) veya paragraf listesi."""
    parts = [title(name)] + [para(line) for line in lyrics] + [para()]
    if story is not None:
        parts += [para(line) for line in ([story] if isinstance(story, str) else story)]
    return "".join(parts + [para()] * blank_after)


def write_docx(path, body):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types/>')
        archive.writestr("word/document.xml", DOC_HEAD + body + DOC_TAIL)
    return path


def protected():
    return isa.forms.protected_files(CATALOG_PATH, MUSIC_ROOT)


class SongArchiveTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.before = protected()
        cls.webp = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (MUSIC_ROOT / "images").glob("*.webp")}

    @classmethod
    def tearDownClass(cls):
        assert protected() == cls.before, "katalog/content dosyaları değişti!"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def analyze(self, body, name="arsiv.docx", privacy_review=None):
        path = write_docx(self.dir / name, body)
        summary, manifest, works = isa.analyze(path, MERGED_CATALOG, MUSIC_ROOT, privacy_review=privacy_review)
        return summary, {e["source_section"]: e for e in manifest}, {w["work_id"]: w for w in works}

    def sections(self, body):
        path = write_docx(self.dir / "s.docx", body)
        paragraphs, _markup = isa.read_archive(path)
        return isa.split_sections(paragraphs)

    def cli(self, *args):
        return subprocess.run([sys.executable, str(TOOL), *args], capture_output=True, text=True, encoding="utf-8")

    # Otomatik numaralı başlıklar ve paragraf muhasebesi
    def test_numbered_titles_define_sections(self):
        sections, roles = self.sections(section("Ağlama") + section("Aşkım", story="Hikayesi: 2026/ Sentetik.")
                                        + section("Fishka"))
        self.assertEqual([s["sourceTitle"] for s in sections], ["Ağlama", "Aşkım", "Fishka"])
        self.assertNotIn(None, roles)
        self.assertEqual(roles.count("title"), 3)

    def test_unnumbered_bold_line_is_not_a_title(self):
        sections, _ = self.sections(section("Ağlama", lyrics=["Ağlama", "Nakarat", "Ağlama"]))
        self.assertEqual(len(sections), 1)

    # Çok sayfalı eser: sayfa sonu sınır değildir
    def test_page_breaks_are_not_boundaries(self):
        page = para("Üçüncü satır", '<w:r><w:lastRenderedPageBreak/><w:t>dördüncü</w:t></w:r>')
        body = section("Beni Sal", lyrics=["Bir", "İki"]).replace(para("İki"), para("İki") + page)
        sections, _ = self.sections(body)
        self.assertEqual(len(sections), 1)
        self.assertEqual(sections[0]["pageBreaks"], 1)
        self.assertIn("Üçüncü satırdördüncü", sections[0]["lyrics"])

    # Hikâye işaretleri
    def test_story_marker_variants(self):
        cases = {"Hikayesi: 2026/ Metin.": "2026/ Metin.", "Hikayesi :1992/ Metin.": "1992/ Metin.",
                 "Hikayesi 2026/ Metin.": "2026/ Metin.", "Hikayesi:1995/ Metin.": "1995/ Metin.",
                 "Hikâyesi: Metin.": "Metin.", "  Hikayesi:  Metin.": "Metin."}
        for marker, expected in cases.items():
            with self.subTest(marker=marker):
                sections, _ = self.sections(section("Ağlama", story=marker))
                self.assertEqual(sections[0]["story"], expected)
                self.assertFalse(sections[0]["storyMarkerSeparate"])
                self.assertNotIn(marker.strip()[:8], sections[0]["lyrics"])

    def test_story_starts_in_next_paragraph(self):
        sections, roles = self.sections(section("Ağlama", story=["Hikayesi:", "2026/ Sonraki paragraf."]))
        self.assertEqual(sections[0]["story"], "2026/ Sonraki paragraf.")
        self.assertTrue(sections[0]["storyMarkerSeparate"])
        self.assertEqual((roles.count("story-marker"), roles.count("story")), (1, 1))

    def test_multi_paragraph_story_keeps_inner_blank(self):
        sections, _ = self.sections(section("Ağlama", story=["Hikayesi: Bir.", "", "İki."]))
        self.assertEqual(sections[0]["story"], "Bir.\n\nİki.")

    def test_hikaye_word_inside_lyrics_is_not_marker(self):
        lyrics = ["Bu bir hikaye…", "Hikâyemiz tek, başımız dik", "Her biten hikâyede"]
        sections, _ = self.sections(section("Ağlama", lyrics=lyrics, story="Hikayesi: Gerçek işaret."))
        self.assertEqual(sections[0]["lyrics"], "\n".join(lyrics))
        self.assertEqual(sections[0]["story"], "Gerçek işaret.")
        self.assertEqual(sections[0]["lyricsHikayeWord"], 3)

    # Boş satırlar ve karakterler
    def test_blank_lines_and_stanzas_preserved(self):
        lyrics = ["Kıta bir", "satır", "", "Nakarat", "", "", "Köprü  ", "son"]
        sections, roles = self.sections(section("Ağlama", lyrics=lyrics, story="Hikayesi: x"))
        self.assertEqual(sections[0]["lyrics"], "Kıta bir\nsatır\n\nNakarat\n\n\nKöprü  \nson")
        self.assertEqual(isa.text_stats(sections[0]["lyrics"])["stanzas"], 3)
        self.assertGreaterEqual(roles.count("blank-edge"), 3)

    def test_turkish_german_and_emoji_preserved(self):
        alt = ('<w:r><mc:AlternateContent><mc:Choice Requires="w16se"><w16se:symEx w16se:font="Segoe UI Emoji" '
               'w16se:char="1F60A"/></mc:Choice><mc:Fallback><w:t>\U0001F60A</w:t></mc:Fallback></mc:AlternateContent></w:r>')
        lyrics = ["Çığlık öğün ışık İĞÜŞÖÇ", "Größe für Mädchen ÄÖÜß", "„Zitat“ — ‘tırnak’… 🎂✨"]
        body = section("Ağlama", lyrics=lyrics).replace(para("Größe für Mädchen ÄÖÜß"),
                                                        para("Größe für Mädchen ÄÖÜß", alt))
        path = write_docx(self.dir / "e.docx", body)
        paragraphs, markup = isa.read_archive(path)
        sections, _ = isa.split_sections(paragraphs)
        self.assertEqual(sections[0]["lyrics"], "Çığlık öğün ışık İĞÜŞÖÇ\nGröße für Mädchen ÄÖÜß\U0001F60A\n"
                                                "„Zitat“ — ‘tırnak’… 🎂✨")
        self.assertEqual(markup, {"alternateContentResolved": 1, "alternateContentMismatched": 0})
        self.assertEqual(sections[0]["issues"], [])
        stats = isa.text_stats(sections[0]["lyrics"])
        self.assertEqual((stats["emoji"], stats["germanSpecific"]), (3, 4))

    def test_alternate_content_mismatch_is_structural(self):
        alt = ('<w:r><mc:AlternateContent><mc:Choice Requires="w16se"><w16se:symEx w16se:char="1F60A"/></mc:Choice>'
               '<mc:Fallback><w:t>X</w:t></mc:Fallback></mc:AlternateContent></w:r>')
        summary, _, _ = self.analyze(section("Ağlama").replace(para("İkinci satır"), para("İkinci satır", alt)))
        self.assertTrue(any("AlternateContent" in p for p in summary["structuralProblems"]))

    def test_unknown_element_is_reported_as_loss(self):
        sym = '<w:r><w:sym w:font="Wingdings" w:char="F04A"/></w:r>'
        summary, entries, _ = self.analyze(section("Ağlama").replace(para("İkinci satır"), para("İkinci satır", sym)))
        self.assertEqual(entries[1]["integrity"], "lossy")
        self.assertTrue(summary["structuralProblems"])

    # Aynı Work'e bağlı iki Recording
    def test_two_recordings_identical_lyrics_share_work_content(self):
        story = "Hikayesi: 2026/ Ortak sentetik hikâye."
        _, entries, works = self.analyze(section("Biliyorum", story=story)
                                         + section("Biliyorum (Rock Ballad Version)", story=story))
        self.assertEqual((entries[1]["recording_id"], entries[2]["recording_id"]), ("r-0015", "r-0014"))
        plan = works["w-0014"]
        self.assertEqual([l["scope"] for l in plan["lyrics"]], ["work"])
        self.assertEqual(plan["lyrics"][0]["file"], "content/lyrics/w-0014.txt")
        self.assertEqual((plan["story"]["rule"], plan["story"]["status"]), ("VERSION_SHARED", "RESOLVED"))
        self.assertEqual(plan["story"]["file"], "content/stories/w-0014.txt")

    def test_different_version_lyrics_stay_per_recording(self):
        story = "Hikayesi: 2026/ Ortak."
        a = section("Turizmci", lyrics=["Aynı", "", "söz"], story=story)
        b = section("Turizmci (Pop Versiyon)", lyrics=["Aynı", "söz"], story=story)
        _, _, works = self.analyze(a + b)
        plan = works["w-0056"]
        self.assertEqual([(l["scope"], l["target"]) for l in plan["lyrics"]],
                         [("recording", "recording:r-0059"), ("recording", "recording:r-0058")])
        self.assertNotEqual(plan["lyrics"][0]["sha256"], plan["lyrics"][1]["sha256"])
        self.assertEqual(plan["story"]["status"], "RESOLVED")

    def test_shared_story_pending_when_sources_differ(self):
        body = (section("Öyle Bir Şey (Akustik )", story="Hikayesi: Birinci sürüm.")
                + section("Böyle Bir Şey (Rock’n Roll)", story="Hikayesi: İkinci sürüm."))
        _, entries, works = self.analyze(body)
        self.assertEqual([entries[1]["recording_id"], entries[2]["recording_id"]], ["r-0051", "r-0021"])
        story = works["w-0020"]["story"]
        self.assertEqual((story["status"], story["sha256"], len(story["sources"])), ("PENDING_APPROVAL", None, 2))
        self.assertEqual(works["w-0020"]["approval_status"], "PENDING_APPROVAL")

    # Burçlar için sabit ortak hikâye
    def test_zodiac_shared_story(self):
        body = "".join(section(t, story="Hikayesi:2026/ Sentetik burç kaynağı." if t == "Koç" else None)
                       for t in ZODIAC_TITLES) + section("Ben Boğa’yım", story="Hikayesi: Başka.")
        summary, _, works = self.analyze(body)
        zodiac = [w for w in works.values() if w["story"].get("rule") == "ZODIAC_SHARED"]
        self.assertEqual(len(zodiac), 12)
        self.assertEqual(sorted(w["work_id"] for w in zodiac), sorted(summary["zodiacWorks"]))
        self.assertTrue(all(w["story"]["sha256"] == isa.sha(isa.ZODIAC_STORY) for w in zodiac))
        koc = works["w-0044"]["story"]
        self.assertEqual(len(koc["sources"]), 1)
        self.assertTrue(koc["sourceDiffersFromApplied"])
        self.assertEqual(works["w-0010"]["story"]["rule"], "SOURCE")
        self.assertEqual(isa.ZODIAC_STORY,
                         "2026/ Sosyal Medyada paylaşılan resim/videolara eklensin diye yazdım. Bol bol ekleyin.")

    # Eşleştirme
    def test_user_approved_matches(self):
        body = "".join(section(t) for t in isa.APPROVED_MATCHES)
        _, entries, _ = self.analyze(body)
        for number, (name, (work_id, rec_id)) in enumerate(isa.APPROVED_MATCHES.items(), 1):
            with self.subTest(title=name):
                self.assertEqual((entries[number]["match_status"], entries[number]["work_id"]),
                                 ("USER_APPROVED", work_id))
                if rec_id:
                    self.assertEqual(entries[number]["recording_id"], rec_id)

    def test_yenik_yuregim_second_version_stays_pending(self):
        story = "Hikayesi: 2026/ Ortak."
        body = (section("Yenik Yüreğim (Thrash Metal )", lyrics=["Thrash sözü"], story=story)
                + section("Yenik Yüreğim", lyrics=["Pop sözü"], story=story))
        _, entries, works = self.analyze(body)
        self.assertEqual((entries[1]["recording_id"], entries[1]["recording_status"]), ("r-0065", "CONFIRMED"))
        self.assertEqual((entries[2]["work_id"], entries[2]["recording_id"], entries[2]["recording_status"]),
                         ("w-0061", "r-0064", "PROBABLE_PENDING"))
        plan = works["w-0061"]
        self.assertEqual([l["scope"] for l in plan["lyrics"]], ["recording", "recording"])
        self.assertEqual(plan["lyrics"][1]["status"], "PENDING_APPROVAL")
        self.assertEqual(plan["story"]["status"], "RESOLVED")
        self.assertTrue(any("bölüm 2" in p for p in plan["pending"]))

    def test_live_catalog_stale_approvals_for_moved_recordings_stay_pending(self):
        # Görev 25 sonrası canlı katalog: r-0065 ve r-0021 artık w-0068 ve w-0066'da. Eski onaylar (w-0061/w-0020)
        # sessizce yanlış esere bağlanmamalı; araç bu bölümleri onaylamadan beklemede bırakır.
        body = (section("Yenik Yüreğim (Thrash Metal )", lyrics=["Thrash sözü"])
                + section("Böyle Bir Şey (Rock'n Roll)", lyrics=["Rock sözü"])
                + section("Öyle Bir Şey (Akustik )", lyrics=["Akustik sözü"]))
        path = write_docx(self.dir / "canli.docx", body)
        _summary, manifest, _works = isa.analyze(path, CATALOG, MUSIC_ROOT)
        entries = {e["source_section"]: e for e in manifest}
        live = {r["id"]: r["workId"] for r in CATALOG["recordings"]}
        self.assertEqual((live["r-0065"], live["r-0021"], live["r-0051"]), ("w-0068", "w-0066", "w-0020"))
        for number in (1, 2):
            with self.subTest(section=number):
                self.assertNotEqual(entries[number]["match_status"], "USER_APPROVED")
                self.assertNotEqual(entries[number]["recording_status"], "CONFIRMED")
        self.assertEqual((entries[3]["match_status"], entries[3]["work_id"], entries[3]["recording_id"]),
                         ("USER_APPROVED", "w-0020", "r-0051"))

    def test_ambiguous_titles_are_not_confirmed(self):
        _, entries, _ = self.analyze(section("Yeni Yüreğim") + section("Ben Boğa") + section("Tamamen Bilinmeyen"))
        self.assertEqual((entries[1]["match_status"], entries[1]["work_id"]), ("PROBABLE_PENDING", "w-0061"))
        self.assertEqual(entries[2]["match_status"], "PROBABLE_PENDING")
        self.assertIn("w-0010", entries[2]["candidates"])
        self.assertNotEqual(entries[2]["recording_status"], "CONFIRMED")
        self.assertEqual(entries[3]["match_status"], "NOT_FOUND")
        self.assertTrue(all(e["approval_status"] == "PENDING_APPROVAL" for e in entries.values()))

    def test_normalized_match(self):
        _, entries, _ = self.analyze(section(" Yay") + section("Du Bist Der grund") + section("Yoksun ama…"))
        self.assertEqual([entries[n]["match_status"] for n in (1, 2, 3)], ["NORMALIZED"] * 3)
        self.assertEqual([entries[n]["work_id"] for n in (1, 2, 3)], ["w-0059", "w-0026", "w-0063"])

    # Eksik hikâye ve işaretsiz hikâye adayı
    def test_missing_story(self):
        summary, entries, works = self.analyze(section("Ağlama"))
        self.assertFalse(entries[1]["story_source"]["present"])
        self.assertEqual(works["w-0001"]["story"]["rule"], "MISSING")
        self.assertEqual(summary["storyMissingSections"], [1])

    def test_unmarked_story_candidate(self):
        body = section("Bugün Benim Doğum Günüm", lyrics=["Söz", "", isa.ZODIAC_STORY])
        summary, entries, works = self.analyze(body)
        self.assertEqual(summary["unmarkedStoryCandidates"], [1])
        self.assertTrue(entries[1]["unmarked_story_candidate"]["equalsZodiacStory"])
        story = works["w-0021"]["story"]
        self.assertEqual((story["rule"], story["status"]), ("UNMARKED_CANDIDATE", "PENDING_APPROVAL"))

    # Gizlilik
    def test_privacy_flags(self):
        body = (section("Ben Boğa’yım", story="Hikayesi: Sentetik zararsız metin.")
                + section("Ağlama", story="Hikayesi: @ornekhesap için yazdım.")
                + section("Aşkım", story="Hikayesi: Sentetik zararsız metin."))
        # Genel kalıp taraması dış dosya olmadan da çalışır; eser bazında karar yoksa zararsız metin işaretlenmez.
        _, _, works = self.analyze(body)
        self.assertIn("sosyal medya hesabı", works["w-0001"]["privacyCategories"])
        self.assertFalse(works["w-0010"]["privacy_review_required"])
        self.assertFalse(works["w-0006"]["privacy_review_required"])
        # Eser bazında kararlar (sentetik) dışarıdan verildiğinde uygulanır ve onayı bekletir.
        _, _, works = self.analyze(body, privacy_review={"w-0010": "sentetik inceleme kategorisi"})
        self.assertEqual(works["w-0010"]["privacyCategories"], ["sentetik inceleme kategorisi"])
        self.assertEqual(works["w-0010"]["approval_status"], "PENDING_APPROVAL")
        self.assertFalse(works["w-0006"]["privacy_review_required"])

    def test_no_work_level_privacy_decisions_in_source(self):
        # Görev 28: herkese açık kaynak kodda eser kimliğine bağlı gizlilik kararı tutulmaz.
        self.assertFalse(hasattr(isa, "PRIVACY_REVIEW"))
        source = TOOL.read_text(encoding="utf-8")
        self.assertNotRegex(source, r'"w-\d{4}"\s*:\s*"[^"]*(sağlık|yas|kayıp|tarih|kişi|hesab|aile)')

    def test_cli_privacy_review_file_must_be_outside_repo(self):
        good = write_docx(self.dir / "iyi.docx", section("Ağlama", story="Hikayesi: Sentetik zararsız metin."))
        inside = MUSIC_ROOT / "gizlilik.json"
        result = self.cli("--source", str(good), "--report-dir", str(self.dir / "r1"), "--privacy-review", str(inside))
        self.assertEqual(result.returncode, 2)
        self.assertIn("repo içinde olamaz", result.stderr)
        self.assertFalse(inside.exists())
        outside = self.dir / "gizlilik.json"
        outside.write_text('{"w-0001": "sentetik inceleme kategorisi"}', encoding="utf-8")
        result = self.cli("--source", str(good), "--report-dir", str(self.dir / "r2"), "--privacy-review", str(outside))
        self.assertIn(result.returncode, (0, 1), result.stderr)
        report = json.loads((self.dir / "r2" / "manifest.json").read_text(encoding="utf-8"))
        work = next(w for w in report["works"] if w["work_id"] == "w-0001")
        self.assertEqual(work["privacyCategories"], ["sentetik inceleme kategorisi"])

    # Mevcut içerikle çakışma
    def test_published_conflict_is_pending(self):
        _, _, works = self.analyze(section("Çok Sevince İnsanı", story="Hikayesi: Sentetik farklı hikâye."))
        conflicts = {c["file"]: c["status"] for c in works["w-0025"]["conflicts"]}
        self.assertEqual(conflicts, {"content/lyrics/w-0025.txt": "PENDING_APPROVAL",
                                     "content/stories/w-0025.txt": "PENDING_APPROVAL"})

    def test_identical_published_content_is_not_conflict(self):
        lines = (MUSIC_ROOT / "content/lyrics/w-0025.txt").read_text(encoding="utf-8").rstrip("\n").split("\n")
        _, _, works = self.analyze(section("Çok Sevince İnsanı", lyrics=lines))
        self.assertEqual(works["w-0025"]["conflicts"], [])

    # Kaynak ve katalog değişmez; rapor metin içermez
    def test_cli_dry_run_leaves_source_and_catalog_unchanged(self):
        secret = "GİZLİSENTETİKSÖZ-QZX"
        path = write_docx(self.dir / "kaynak.docx", section("Ağlama", lyrics=[secret], story="Hikayesi: GİZLİHİKÂYE-QZX"))
        before_src, before_cat = hashlib.sha256(path.read_bytes()).hexdigest(), protected()
        result = self.cli("--source", str(path), "--dry-run", "--report-dir", str(self.dir / "rapor"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before_src)
        self.assertEqual(protected(), before_cat)
        self.assertIn("kaynak değişmedi: evet", result.stdout)
        for text in [result.stdout] + [p.read_text(encoding="utf-8") for p in (self.dir / "rapor").iterdir()]:
            self.assertNotIn("QZX", text)

    def test_cli_rejects_bad_input_and_report_dir_in_repo(self):
        bad = self.dir / "bozuk.docx"
        bad.write_bytes(b"PK bozuk")
        self.assertEqual(self.cli("--source", str(bad), "--report-dir", str(self.dir / "r")).returncode, 2)
        good = write_docx(self.dir / "iyi.docx", section("Ağlama"))
        self.assertEqual(self.cli("--source", str(good), "--report-dir", str(MUSIC_ROOT / "rapor")).returncode, 2)
        self.assertFalse((MUSIC_ROOT / "rapor").exists())
        self.assertEqual(self.cli("--source", str(good), "--report-dir", str(self.dir / "r2"),
                                  "--expect-sections", "68").returncode, 1)

    def test_webp_unchanged(self):
        now = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (MUSIC_ROOT / "images").glob("*.webp")}
        self.assertEqual((len(now), now), (204, self.webp))


if __name__ == "__main__":
    unittest.main(verbosity=2)
