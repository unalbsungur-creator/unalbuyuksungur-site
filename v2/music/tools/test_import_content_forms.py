#!/usr/bin/env python3
"""import_content_forms.py için sentetik testler (standart kütüphane unittest).

Gerçek kullanıcı belgesi kullanılmaz: her test, form şablonunun yapısını taklit eden
DOCX dosyalarını geçici bir klasörde üretir. Gerçek katalog yalnızca okunur; testlerin
başında ve sonunda catalog.json, schema.json ve content/ dosyalarının SHA-256 değerleri
karşılaştırılır.

Kullanım:
    python v2/music/tools/test_import_content_forms.py
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
import import_content_forms as icf  # noqa: E402

TOOL = Path(icf.__file__).resolve()
CATALOG = icf.DATA_DIR / "catalog.json"
MUSIC_ROOT = icf.MUSIC_ROOT
SPOTIFY_TRACK = "https://open.spotify.com/track/0123456789abcdefABCDEF"
YOUTUBE_VIDEO = "https://www.youtube.com/watch?v=abcDEF12345"
YTMUSIC_TRACK = "https://music.youtube.com/watch?v=abcDEF12345"
APPLE_SONG = "https://music.apple.com/tr/song/ornek/1234567890"

# --- Sentetik DOCX üretimi -----------------------------------------------------

DOC_HEAD = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>')
DOC_TAIL = "<w:sectPr/></w:body></w:document>"


def runs(text, rpr=""):
    """Metni run'lara çevirir; metin içindeki \\n Word satır sonu (w:br) olur."""
    pieces = [f'<w:t xml:space="preserve">{escape(part)}</w:t>' for part in text.split("\n")]
    return f"<w:r>{rpr}{'<w:br/>'.join(pieces)}</w:r>"


def para(text="", style=None, inner=None):
    ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    return f"<w:p>{ppr}{inner if inner is not None else (runs(text) if text else '')}</w:p>"


def table(rows):
    """rows: (etiket, değer) çiftleri; değer ham XML için ("xml", "<w:p>…</w:p>") olabilir."""
    out = []
    for label, value in rows:
        cell = value[1] if isinstance(value, tuple) else para(value)
        out.append(f"<w:tr><w:tc>{para(label)}</w:tc><w:tc>{cell}</w:tc></w:tr>")
    return "<w:tbl>" + "".join(out) + "</w:tbl>"


def recording(version="", rid="", original="", spotify="", apple="", ytmusic="", youtube="", other="",
              differ=""):
    return table([
        ("Versiyon / kayıt adı *", version or "[Orijinal / Akustik / Rock Ballad / vb.]"),
        ("Recording ID", rid or "[Biliniyorsa r-XXXX]"),
        ("Orijinal kayıt mı?", original or "[Evet / Hayır / Bilmiyorum]"),
        ("Müzik tarzı", "[Pop, rock, akustik vb.]"),
        ("Spotify şarkı/tekli URL", spotify or "[Tam bağlantı]"),
        ("Apple Music şarkı URL", apple or "[Tam bağlantı]"),
        ("YouTube Music şarkı URL", ytmusic or "[Tam bağlantı]"),
        ("YouTube video URL", youtube or "[Varsa]"),
        ("Diğer dinleme URL", other or "[Varsa]"),
        ("Bu kaydın sözleri farklı mı?", differ or "[Hayır / Evet — farklıysa ayrıca ekleyin]"),
    ])


def form(title="", work_id="", language="", lyrics=None, story=None, recordings=(), approve_lyrics="",
         approve_story="", approve_links="", private=""):
    """Şablonla aynı sırada bir form. lyrics/story: paragraf listesi (None = yer tutucu kalır)."""
    parts = [para("MÜZİK ESERİ BİLGİ FORMU", "Title"),
             para("A — ESER / WORK", "Heading1"),
             table([("Eser adı *", title or "[Şarkının tam adı]"),
                    ("Work ID", work_id or "[Biliniyorsa w-XXXX; aksi halde boş]"),
                    ("Dil", language or "[Türkçe / Almanca / diğer]")]),
             para("B — ŞARKI SÖZLERİ / LYRICS", "Heading1"),
             para("Sözleri eksiksiz yapıştırın. [Verse], [Chorus], [Bridge], kıta başlıkları, tekrarlar, "
                  "noktalama ve satır sonları aynen korunsun.")]
    parts += [para(line) for line in lyrics] if lyrics is not None else [para(icf.LYRICS_PLACEHOLDER)]
    parts += [para("C — ESERİN HİKÂYESİ / STORY", "Heading1"), para(icf.STORY_LABEL)]
    parts += [para(line) for line in story] if story is not None else [para(icf.STORY_PLACEHOLDER)]
    parts.append(para("D — KAYIT / RECORDING (HER VERSİYON İÇİN TEKRARLAYIN)", "Heading1"))
    parts += list(recordings) or [recording()]
    parts += [para("E — YAYIN VE GİZLİLİK ONAYI", "Heading1"),
              table([("Sözlerin siteye eklenmesi", approve_lyrics or "[Onaylı / Henüz onaylamıyorum]"),
                     ("Hikâyenin siteye eklenmesi", approve_story or "[Onaylı / Taslak / Yayınlama]"),
                     ("Dinleme bağlantıları", approve_links or "[Onaylı / Kontrol edilecek]"),
                     ("Yalnızca özel notlar", private or "[YAYINLANMAYACAK — varsa ayrıca belirtin]")])]
    return "".join(parts)


def complete_form(**overrides):
    values = dict(title="Biliyorum", lyrics=["[Verse]", "Birinci satır", "İkinci satır"],
                  story=["Sentetik hikâye metni."],
                  recordings=[recording(version="Orijinal", spotify=SPOTIFY_TRACK)],
                  approve_lyrics="Onaylı", approve_story="Taslak", approve_links="Onaylı")
    values.update(overrides)
    return form(**values)


def write_docx(path, body, rels=""):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types/>')
        archive.writestr("word/document.xml", DOC_HEAD + body + DOC_TAIL)
        archive.writestr("word/_rels/document.xml.rels",
                         '<?xml version="1.0"?><Relationships '
                         'xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                         f"{rels}</Relationships>")
    return path


def protected_hashes():
    return icf.protected_files(CATALOG, MUSIC_ROOT)


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


def write_fixture_catalog(path):
    """Gerçek katalogun, yalnızca w-0025'in yayımlanmış içeriği olan kopyası.

    Testler aracın mantığını sınar; sitede hangi eserlerin yayımlandığına bağlı kalmamalıdır.
    w-0025 gerçek content/ dosyalarına bağlı kalır (yayımlanmış içerikle çakışma testleri için).
    Çok versiyonlu eser senaryoları için Görev 25'te ayrılan çiftler birleştirilir (merge_split_works).
    """
    data = merge_split_works(json.loads(CATALOG.read_text(encoding="utf-8")))
    for work in data["works"]:
        if work["id"] != "w-0025":
            work["lyrics"] = {"status": "missing", "file": None}
            work["story"] = {"status": "missing", "file": None}
    for recording in data["recordings"]:
        recording.pop("lyrics", None)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


class ImportFormsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.before = protected_hashes()
        cls.webp_before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                           for p in (MUSIC_ROOT / "images").glob("*.webp")}
        cls.fixture_dir = tempfile.TemporaryDirectory()
        cls.fixture = write_fixture_catalog(Path(cls.fixture_dir.name) / "catalog.json")

    @classmethod
    def tearDownClass(cls):
        cls.fixture_dir.cleanup()
        assert protected_hashes() == cls.before, "katalog/content dosyaları değişti!"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def evaluate(self, body, rels="", name="form.docx"):
        path = write_docx(self.dir / name, body, rels)
        summary, reports = icf.run(path, self.fixture, MUSIC_ROOT, self.dir / "report")
        self.assertTrue(summary["catalogUnchanged"])
        return summary, reports

    def one(self, body, rels=""):
        _summary, reports = self.evaluate(body, rels)
        self.assertEqual(len(reports), 1)
        return reports[0]

    def cli(self, *args):
        return subprocess.run([sys.executable, str(TOOL), "--catalog", str(self.fixture), "--music-root", str(MUSIC_ROOT),
                               *args], capture_output=True, text=True, encoding="utf-8")

    # 1. Tek eser
    def test_single_form_ready(self):
        report = self.one(complete_form())
        self.assertEqual(report["status"], icf.READY, report)
        self.assertEqual((report["workId"], report["matchMethod"]), ("w-0014", "exact-title"))
        self.assertEqual(report["recordings"][0]["recordingId"], "r-0015")
        self.assertTrue(report["recordings"][0]["links"]["spotify"]["valid"])
        self.assertEqual(report["lyrics"]["fidelity"], "verified")
        self.assertEqual(report["publishEligible"], {"lyrics": True, "story": False, "links": True})

    # 2. Birden fazla eser
    def test_multiple_forms(self):
        body = complete_form() + complete_form(title="Ağlama", recordings=[recording(version="Ağlama")])
        _summary, reports = self.evaluate(body)
        self.assertEqual([r["workId"] for r in reports], ["w-0014", "w-0001"])
        self.assertEqual(reports[1]["recordings"][0]["recordingId"], "r-0001")

    # 3. Aynı eserin iki versiyonu
    def test_two_versions_same_work(self):
        report = self.one(complete_form(recordings=[
            recording(version="Orijinal", original="Evet", spotify=SPOTIFY_TRACK),
            recording(version="Rock Ballad Version", original="Hayır", youtube=YOUTUBE_VIDEO)]))
        self.assertEqual([r["recordingId"] for r in report["recordings"]], ["r-0015", "r-0014"])
        self.assertEqual(report["status"], icf.READY, report)

    def test_version_name_must_match_exactly(self):
        report = self.one(complete_form(recordings=[recording(version="Rock Ballad")]))
        rec = report["recordings"][0]
        self.assertEqual((rec["status"], rec["recordingId"], rec["candidates"]), (icf.AMBIGUOUS, None, ["r-0014"]))
        self.assertEqual(report["status"], icf.AMBIGUOUS)

    def test_multi_recording_work_without_version_is_ambiguous(self):
        report = self.one(complete_form(title="Turizmci", recordings=[recording(spotify=SPOTIFY_TRACK)]))
        self.assertEqual(report["recordings"][0]["status"], icf.AMBIGUOUS)
        self.assertIn("D#1: Versiyon / kayıt adı", report["missing"])

    def test_original_answer_contradicting_catalog(self):
        report = self.one(complete_form(recordings=[recording(version="Rock Ballad Version", original="Evet")]))
        self.assertEqual(report["status"], icf.AMBIGUOUS)
        self.assertTrue(any("çelişiyor" in c for c in report["conflicts"]))

    # 4. Yanlış Work ID
    def test_wrong_work_id(self):
        for given in ("w-0056", "w-9999", "W14"):
            with self.subTest(given=given):
                report = self.one(complete_form(work_id=given))
                self.assertEqual((report["status"], report["workId"]), (icf.AMBIGUOUS, None))
                self.assertIn("w-0014", [c["workId"] for c in report["candidates"]])

    def test_correct_work_id(self):
        report = self.one(complete_form(work_id="w-0014"))
        self.assertEqual((report["status"], report["matchMethod"]), (icf.READY, "work-id"))

    # 5. Yanlış Recording ID
    def test_wrong_recording_id(self):
        for given, expected in (("r-0058", "başka bir esere"), ("r-9999", "katalogda yok"),
                                ("r-0014", "farklı kayıtları")):
            with self.subTest(given=given):
                report = self.one(complete_form(recordings=[recording(version="Orijinal", rid=given)]))
                self.assertEqual(report["status"], icf.AMBIGUOUS)
                self.assertTrue(any(expected in c for c in report["conflicts"]), report["conflicts"])

    # 6. Benzer başlıklar
    def test_similar_titles(self):
        cases = {
            "Yoksun": (icf.MATCHED, "Yoksun"),
            "Yoksun Ama": (icf.MATCHED, "Yoksun Ama..."),
            "Ben Boğa": (icf.AMBIGUOUS, None),
            "Boga": (icf.AMBIGUOUS, None),
            "Biliyorum Akustik": (icf.AMBIGUOUS, None),
            "Yenik Yüreğim (Akustik)": (icf.AMBIGUOUS, None),
        }
        for title, (status, catalog_title) in cases.items():
            with self.subTest(title=title):
                report = self.one(complete_form(title=title, recordings=[recording()]))
                self.assertEqual(report["matchStatus"], status)
                self.assertEqual(report["catalogTitle"], catalog_title)
        report = self.one(complete_form(title="Ben Boğa", recordings=[recording()]))
        self.assertTrue({"Boğa", "Ben Boğa'yım"} <= {c["title"] for c in report["candidates"]})

    def test_oyle_boyle_bir_sey(self):
        report = self.one(complete_form(title="Öyle Bir Şey", recordings=[recording(spotify=SPOTIFY_TRACK)]))
        self.assertEqual((report["workId"], report["recordings"][0]["recordingId"]), ("w-0020", "r-0051"))
        report = self.one(complete_form(title="Öyle Bir Şey", recordings=[recording(version="Böyle Bir Şey")]))
        self.assertEqual(report["status"], icf.AMBIGUOUS)
        report = self.one(complete_form(title="Öyle Bir Şey / Böyle Bir Şey",
                                        recordings=[recording(spotify=SPOTIFY_TRACK)]))
        self.assertEqual((report["workId"], report["recordings"][0]["status"]), ("w-0020", icf.AMBIGUOUS))

    def test_yenik_yuregim_versions(self):
        report = self.one(complete_form(title="Yenik Yüreğim", recordings=[
            recording(version="Pop Versiyon"), recording(version="Thrash Metal Version")]))
        self.assertEqual([r["recordingId"] for r in report["recordings"]], ["r-0064", "r-0065"])
        report = self.one(complete_form(title="Yenik Yüreğim", recordings=[recording(version="Pop")]))
        self.assertEqual(report["recordings"][0]["candidates"], ["r-0064"])
        self.assertEqual(report["status"], icf.AMBIGUOUS)

    def test_single_recording_with_unknown_version(self):
        report = self.one(complete_form(title="Ağlama", recordings=[recording(version="Akustik")]))
        self.assertEqual(report["status"], icf.AMBIGUOUS)

    # 7. Eksik şarkı sözleri
    def test_missing_lyrics(self):
        report = self.one(complete_form(lyrics=None, approve_lyrics=""))
        self.assertEqual(report["status"], icf.INCOMPLETE)
        self.assertIn("Şarkı sözleri", report["missing"])
        self.assertFalse(report["lyrics"]["present"])

    # 8. Eksik hikâye
    def test_missing_story_is_optional(self):
        report = self.one(complete_form(story=None, approve_story=""))
        self.assertIn("Hikâye", report["missingOptional"])
        self.assertEqual(report["status"], icf.READY)

    # 9. Eksik / belirsiz yayın onayı
    def test_missing_approval(self):
        report = self.one(complete_form(approve_lyrics=""))
        self.assertEqual(report["status"], icf.INCOMPLETE)
        self.assertIn("Yayın onayı: Sözler", report["missing"])
        self.assertFalse(report["publishEligible"]["lyrics"])

    def test_unclear_approval(self):
        report = self.one(complete_form(approve_lyrics="Onaylı / Henüz onaylamıyorum"))
        self.assertEqual(report["approvals"]["lyrics"]["value"], "unclear")
        self.assertEqual(report["status"], icf.INCOMPLETE)

    def test_not_approved_is_review_only(self):
        report = self.one(complete_form(approve_lyrics="Henüz onaylamıyorum"))
        self.assertEqual(report["status"], icf.READY)
        self.assertFalse(report["publishEligible"]["lyrics"])

    # 10. Geçersiz Spotify URL
    def test_invalid_spotify_urls(self):
        for url, expected in (("https://open.spotify.com/track/123", "22 karakterli"),
                              ("https://open.spotify.com/artist/0123456789abcdefABCDEF", "şarkı bağlantısı değil"),
                              ("http://open.spotify.com/track/0123456789abcdefABCDEF", "https değil"),
                              ("open.spotify.com/track/x", "https değil"),
                              ("Spotify'da dinle", "tek bir adres")):
            with self.subTest(url=url):
                report = self.one(complete_form(recordings=[recording(version="Orijinal", spotify=url)]))
                self.assertEqual(report["status"], icf.INCOMPLETE)
                self.assertTrue(any(expected in e for e in report["errors"]), report["errors"])

    def test_album_link_is_warning_not_rewritten(self):
        url = "https://open.spotify.com/intl-tr/album/0123456789abcdefABCDEF"
        report = self.one(complete_form(recordings=[recording(version="Orijinal", spotify=url)]))
        link = report["recordings"][0]["links"]["spotify"]
        self.assertEqual((link["valid"], link["kind"], link["url"]), (True, "album", url))
        self.assertTrue(any("albüm" in w for w in report["warnings"]))

    # 11. Yanlış platform alan adı
    def test_wrong_platform_domain(self):
        for field, url in (("spotify", YOUTUBE_VIDEO), ("youtube", YTMUSIC_TRACK),
                           ("apple", "https://open.spotify.com/track/0123456789abcdefABCDEF"),
                           ("youtube", "https://www.youtube.com/@sanatci")):
            with self.subTest(field=field, url=url):
                report = self.one(complete_form(recordings=[recording(version="Orijinal", **{field: url})]))
                self.assertEqual(report["status"], icf.INCOMPLETE, report["errors"])

    def test_all_platforms_valid(self):
        report = self.one(complete_form(recordings=[recording(
            version="Orijinal", spotify=SPOTIFY_TRACK, apple=APPLE_SONG, ytmusic=YTMUSIC_TRACK,
            youtube="https://youtu.be/abcDEF12345", other="Deezer: https://www.deezer.com/track/123")]))
        self.assertEqual(report["status"], icf.READY, report)
        self.assertEqual(len(report["recordings"][0]["links"]), 5)

    def test_hyperlink_target_mismatch(self):
        rels = ('<Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                'relationships/hyperlink" Target="https://open.spotify.com/track/ZZZZZZZZZZZZZZZZZZZZZZ" '
                'TargetMode="External"/>')
        cell = ("xml", f'<w:p><w:hyperlink r:id="rIdX">{runs(SPOTIFY_TRACK)}</w:hyperlink></w:p>')
        body = complete_form(recordings=[table([("Versiyon / kayıt adı *", "Orijinal"),
                                                ("Spotify şarkı/tekli URL", cell)])])
        report = self.one(body, rels)
        self.assertTrue(any("köprüsünün hedefi" in e for e in report["errors"]))

    # 12-13. Türkçe karakterler, kıta/nakarat satır sonları
    def test_lyrics_preserved_exactly(self):
        lyrics = ["", "[Kıta 1]", "Çığlık öğün şımarık  İĞÜŞÖÇ", "Satır, noktalama!..  ",
                  "", "[Nakarat]", "Tekrar\nTekrar (satır içi kırılma)", "Tekrar", "", "", "[Köprü]", "âîû", ""]
        report = self.one(complete_form(lyrics=lyrics))
        expected = ("[Kıta 1]\nÇığlık öğün şımarık  İĞÜŞÖÇ\nSatır, noktalama!..  \n\n[Nakarat]\n"
                    "Tekrar\nTekrar (satır içi kırılma)\nTekrar\n\n\n[Köprü]\nâîû")
        written = (self.dir / "report" / report["lyrics"]["reviewFile"]).read_bytes()
        self.assertEqual(written, (expected + "\n").encode("utf-8"))
        self.assertEqual((report["lyrics"]["stanzas"], report["lyrics"]["sectionTags"]), (3, 3))
        self.assertEqual(report["lyrics"]["fidelity"], "verified")
        self.assertTrue(any("boş satır çıkarıldı" in n for n in report["lyrics"]["notes"]))
        self.assertTrue(any("satır sonunda boşluk" in n for n in report["lyrics"]["notes"]))

    def test_conversion_losses_reported(self):
        tracked = para(inner=runs("Görünen") + '<w:del><w:r><w:delText>silinen</w:delText></w:r></w:del>')
        listed = '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr>' + runs("Madde") + "</w:p>"
        hidden = para(inner=runs("Açık") + runs("gizli", '<w:rPr><w:vanish/></w:rPr>'))
        body = complete_form().replace(para("Birinci satır"), tracked + listed + hidden)
        report = self.one(body)
        self.assertEqual(report["lyrics"]["fidelity"], "lossy")
        self.assertEqual(report["status"], icf.INCOMPLETE)
        self.assertFalse(report["publishEligible"]["lyrics"])
        self.assertTrue(any("gizli" in n for n in report["lyrics"]["notes"]))

    # 14. Boş Word belgesi
    def test_empty_document(self):
        summary, reports = self.evaluate("")
        self.assertEqual(reports, [])
        self.assertTrue(any("formu bulunamadı" in w for w in summary["documentWarnings"]))
        result = self.cli("--input", str(self.dir / "form.docx"), "--report-dir", str(self.dir / "r2"))
        self.assertEqual(result.returncode, 1)

    # 15. Bozuk DOCX
    def test_corrupt_docx(self):
        bad = self.dir / "bozuk.docx"
        bad.write_bytes(b"PK\x03\x04 bu bir docx degil")
        with self.assertRaises(icf.InputError):
            icf.read_docx(bad)
        no_doc = self.dir / "eksik.docx"
        with zipfile.ZipFile(no_doc, "w") as archive:
            archive.writestr("foo.xml", "<a/>")
        with self.assertRaises(icf.InputError):
            icf.read_docx(no_doc)
        broken = write_docx(self.dir / "xml.docx", "<w:p><w:r>")
        with self.assertRaises(icf.InputError):
            icf.read_docx(broken)
        entity = self.dir / "entity.docx"
        with zipfile.ZipFile(entity, "w") as archive:
            archive.writestr("word/document.xml", '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x/>')
        with self.assertRaises(icf.InputError):
            icf.read_docx(entity)
        result = self.cli("--input", str(bad), "--report-dir", str(self.dir / "r3"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("HATA", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse((self.dir / "r3").exists())

    # 16. Tekrarlanan eser formu
    def test_duplicate_forms(self):
        _summary, reports = self.evaluate(complete_form() + complete_form(work_id="w-0014"))
        self.assertEqual([r["status"] for r in reports], [icf.AMBIGUOUS, icf.AMBIGUOUS])
        self.assertTrue(all(any("birden fazla form" in c for c in r["conflicts"]) for r in reports))

    def test_duplicate_url_across_recordings(self):
        report = self.one(complete_form(recordings=[
            recording(version="Orijinal", spotify=SPOTIFY_TRACK),
            recording(version="Rock Ballad Version", spotify=SPOTIFY_TRACK)]))
        self.assertEqual(report["status"], icf.AMBIGUOUS)

    # 17. Mevcut yayımlanmış içerikle çakışma
    def test_conflict_with_published_content(self):
        report = self.one(complete_form(title="Çok Sevince İnsanı", recordings=[recording()]))
        self.assertEqual(report["status"], icf.AMBIGUOUS)
        self.assertTrue(any("yayımlanmış içerikten" in c for c in report["conflicts"]))

    def test_identical_published_content_is_not_conflict(self):
        lines = (MUSIC_ROOT / "content/lyrics/w-0025.txt").read_text(encoding="utf-8").rstrip("\n").split("\n")
        report = self.one(complete_form(title="Çok Sevince İnsanı", lyrics=lines, story=None, approve_story="",
                                        recordings=[recording()]))
        self.assertFalse(any("lyrics" in c for c in report["conflicts"]), report["conflicts"])
        self.assertIn("lyrics: yayımlanmış içerikle birebir aynı", report["notes"])

    # Canlı (yayımlanmış) katalog regresyonu: fikstür değil, gerçek katalog yalnızca okunur.
    def live(self, body):
        path = write_docx(self.dir / "canli.docx", body)
        summary, reports = icf.run(path, CATALOG, MUSIC_ROOT, self.dir / "canli-rapor")
        self.assertTrue(summary["catalogUnchanged"])
        self.assertEqual(len(reports), 1)
        return reports[0]

    def live_work(self, work_id):
        work = next(w for w in json.loads(CATALOG.read_text(encoding="utf-8"))["works"] if w["id"] == work_id)
        if work["lyrics"]["status"] != "published" or work["story"]["status"] != "published":
            self.skipTest(f"{work_id} canlı katalogda yayımlanmamış")
        return work

    def test_live_catalog_detects_conflict_with_published_work(self):
        work = self.live_work("w-0014")
        report = self.live(complete_form())
        self.assertEqual(report["status"], icf.AMBIGUOUS)
        self.assertTrue(any(work["lyrics"]["file"] in c for c in report["conflicts"]), report["conflicts"])
        self.assertTrue(any(work["story"]["file"] in c for c in report["conflicts"]), report["conflicts"])

    def test_live_catalog_identical_published_content_is_ready(self):
        work = self.live_work("w-0014")
        read = lambda p: (MUSIC_ROOT / p).read_text(encoding="utf-8").rstrip("\n").split("\n")  # noqa: E731
        report = self.live(complete_form(lyrics=read(work["lyrics"]["file"]), story=read(work["story"]["file"])))
        self.assertEqual(report["conflicts"], [])
        self.assertIn("lyrics: yayımlanmış içerikle birebir aynı", report["notes"])
        self.assertIn("story: yayımlanmış içerikle birebir aynı", report["notes"])
        self.assertEqual(report["status"], icf.READY, report)

    def test_live_catalog_split_work_uses_shared_published_files(self):
        # Görev 25: w-0066 (Böyle Bir Şey) kaynak eser w-0020'nin söz/hikâye dosyalarını paylaşır ve tek kaydı r-0021.
        work = self.live_work("w-0066")
        self.assertEqual((work["lyrics"]["file"], work["story"]["file"]),
                         ("content/lyrics/w-0020.txt", "content/stories/w-0020.txt"))
        read = lambda p: (MUSIC_ROOT / p).read_text(encoding="utf-8").rstrip("\n").split("\n")  # noqa: E731
        report = self.live(complete_form(title="Böyle Bir Şey", work_id="w-0066", lyrics=read(work["lyrics"]["file"]),
                                         story=read(work["story"]["file"]), recordings=[recording(version="Böyle Bir Şey")]))
        self.assertEqual(report["workId"], "w-0066")
        self.assertEqual(report["conflicts"], [])
        self.assertIn("lyrics: yayımlanmış içerikle birebir aynı", report["notes"])
        self.assertEqual([r["recordingId"] for r in report["recordings"]], ["r-0021"])

    def test_existing_catalog_link(self):
        catalog = icf.Catalog(icf.json.loads(CATALOG.read_text(encoding="utf-8")))
        url = catalog.recordings["r-0026"]["links"]["spotify"]
        report = self.one(complete_form(title="Çok Sevince İnsanı", lyrics=None, story=None, approve_lyrics="",
                                        approve_story="", recordings=[recording(spotify=url)]))
        self.assertIn("D#1 spotify: adres katalogda zaten bu kayıtta", report["notes"])
        report = self.one(complete_form(recordings=[recording(version="Orijinal", spotify=url)]))
        self.assertTrue(any("başka bir kayda" in c for c in report["conflicts"]))

    # 18. Katalog değişmeden kalır; gizlilik
    def test_catalog_unchanged_and_private_data_not_leaked(self):
        secret_line = "GİZLİSÖZSATIRI-XYZ"
        secret_note = "ÖZELNOT-TELEFON-QWE"
        path = write_docx(self.dir / "f.docx", complete_form(lyrics=[secret_line], private=secret_note))
        before = protected_hashes()
        result = self.cli("--input", str(path), "--dry-run", "--report-dir", str(self.dir / "rep"))
        self.assertEqual(protected_hashes(), before)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn(secret_line, result.stdout)
        self.assertNotIn(secret_note, result.stdout)
        for report_file in (self.dir / "rep").rglob("*"):
            if report_file.is_file():
                self.assertNotIn(secret_note, report_file.read_text(encoding="utf-8"))
        self.assertIn("değişmedi: evet", result.stdout)

    def test_report_dir_inside_repo_refused(self):
        path = write_docx(self.dir / "f.docx", complete_form())
        result = self.cli("--input", str(path), "--report-dir", str(MUSIC_ROOT / "rapor"))
        self.assertEqual(result.returncode, 2)
        self.assertFalse((MUSIC_ROOT / "rapor").exists())

    def test_webp_unchanged(self):
        now = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (MUSIC_ROOT / "images").glob("*.webp")}
        self.assertEqual(len(now), 204)
        self.assertEqual(now, self.webp_before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
