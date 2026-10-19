#!/usr/bin/env python3
"""Eser–kayıt eşleşmesi, açılış kaydı ve sürüm etiketi için regresyon testi (unittest).

Görev 23–24'te çok versiyonlu eserlerin açılış kaydı (DEFAULT_RECORDINGS) sınanıyordu. Görev 25 kullanıcı
kararıyla dört birleşik eser sekiz bağımsız esere ayrıldı: her eserin tek kaydı vardır, eser sayfası ve
arşiv kartı o kaydı (ve kapağını) gösterir; eski birleşik eser bağlantıları kaydın yeni eserine yönlendirilir.
Katalog yalnızca okunur.

Kullanım:
    python v2/music/tools/test_default_recordings.py
"""

import json
import re
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True  # v2/ altında __pycache__ oluşmasın (herkese açık klasör)

MUSIC_ROOT = Path(__file__).resolve().parent.parent
CATALOG = json.loads((MUSIC_ROOT / "data" / "catalog.json").read_text(encoding="utf-8"))
WORK_JS = (MUSIC_ROOT / "work" / "work.js").read_text(encoding="utf-8")
CATALOG_JS = (MUSIC_ROOT / "catalog.js").read_text(encoding="utf-8")
WORKS = {w["id"]: w for w in CATALOG["works"]}
RECORDINGS = {r["id"]: r for r in CATALOG["recordings"]}

# Görev 25 kullanıcı kararı: kaynak eser -> (eserde kalan kayıt, ayrılan kayıt, yeni eser).
SPLITS = {
    "w-0014": ("r-0015", "r-0014", "w-0065"),  # Biliyorum: Pop | Rock Ballad
    "w-0020": ("r-0051", "r-0021", "w-0066"),  # Öyle Bir Şey (Akustik) | Böyle Bir Şey (Rock'n Roll)
    "w-0056": ("r-0059", "r-0058", "w-0067"),  # Turizmci | Turizmci (Pop Versiyon)
    "w-0061": ("r-0064", "r-0065", "w-0068"),  # Yenik Yüreğim: Pop | Thrash Metal
}


def js_map(source, name):
    match = re.search(r"var " + name + r" = (\{[^}]*\});", source)
    if not match:
        raise AssertionError(name + " bulunamadı")
    return json.loads(match.group(1))


def recordings_of(work_id):
    return [r["id"] for r in CATALOG["recordings"] if r["workId"] == work_id]


def old_link_target(work_id, recording_id):
    # work.js: ?kayit başka bir esere aitse o esere yönlendirilir.
    recording = RECORDINGS.get(recording_id)
    return recording["workId"] if recording and recording["workId"] != work_id else work_id


class WorkRecordingTests(unittest.TestCase):
    def test_every_work_has_exactly_one_recording(self):
        self.assertEqual((len(WORKS), len(RECORDINGS)), (68, 68))
        for work_id in WORKS:
            self.assertEqual(len(recordings_of(work_id)), 1, work_id)
        for recording in RECORDINGS.values():
            self.assertIn(recording["workId"], WORKS)

    def test_split_works_have_own_recording_cover_and_shared_content(self):
        for source, (keep, move, new) in SPLITS.items():
            with self.subTest(work=source):
                self.assertEqual(recordings_of(source), [keep])
                self.assertEqual(recordings_of(new), [move])
                self.assertNotEqual(RECORDINGS[keep]["coverId"], RECORDINGS[move]["coverId"])
                self.assertEqual(WORKS[new]["lyrics"], WORKS[source]["lyrics"])
                self.assertEqual(WORKS[new]["story"], WORKS[source]["story"])
                self.assertEqual(WORKS[new]["title"], RECORDINGS[move]["title"])
                self.assertNotIn("lyrics", RECORDINGS[move])
        self.assertEqual(WORKS["w-0020"]["title"], "Öyle Bir Şey")

    def test_old_combined_links_redirect_to_new_work(self):
        self.assertIn("moved.workId !== workId", WORK_JS)
        for source, (keep, move, new) in SPLITS.items():
            self.assertEqual(old_link_target(source, move), new)
            self.assertEqual(old_link_target(source, keep), source)

    def test_no_default_recording_map_and_card_uses_only_recording(self):
        # Tek kayıtlı eserlerde açılış kaydı eşlemesi gereksizdir; kart ve detay aynı (tek) kaydı kullanır.
        self.assertNotIn("DEFAULT_RECORDINGS", WORK_JS)
        self.assertNotIn("DEFAULT_RECORDINGS", CATALOG_JS)
        self.assertEqual(RECORDINGS[recordings_of("w-0020")[0]]["coverId"], "c-0051")
        self.assertEqual(RECORDINGS[recordings_of("w-0066")[0]]["coverId"], "c-0021")

    def test_version_tags_label_oyle_and_boyle_recordings(self):
        tags = js_map(WORK_JS, "VERSION_TAGS")
        self.assertEqual(tags, {"r-0051": "Akustik", "r-0021": "Rock'n Roll"})
        self.assertEqual((RECORDINGS["r-0051"]["workId"], RECORDINGS["r-0021"]["workId"]), ("w-0020", "w-0066"))
        for recording_id in tags:
            # Etiket yalnızca arayüzde; katalogdaki sürüm alanları ve orijinallik (oi-0001) değişmez.
            self.assertIsNone(RECORDINGS[recording_id]["versionLabel"])
            self.assertEqual(RECORDINGS[recording_id]["genres"], [])
            self.assertIsNone(RECORDINGS[recording_id]["isOriginal"])
        self.assertIn("oi-0001", {issue["id"] for issue in CATALOG["openIssues"]})

    def test_catalog_json_is_not_preloaded(self):
        # Görev 26: <link rel="preload"> yanıtı tarayıcı önbelleğinden (Cache-Control yokken tahmini tazelik) gelip
        # fetch(..., {cache: "no-cache"}) tarafından devralınıyor; katalog güncellenince eski eserler görünüyordu.
        for page in (MUSIC_ROOT / "index.html", MUSIC_ROOT / "work" / "index.html"):
            html = page.read_text(encoding="utf-8")
            self.assertNotRegex(html, r'rel="preload"[^>]*catalog\.json', page.name)
        self.assertIn('fetch(CATALOG_URL, { cache: "no-cache" })', CATALOG_JS)
        self.assertIn('fetch(CATALOG_URL, { cache: "no-cache" })', WORK_JS)

    def test_aglama_story_correction(self):
        story = (MUSIC_ROOT / WORKS["w-0001"]["story"]["file"]).read_text(encoding="utf-8")
        self.assertEqual(WORKS["w-0001"]["title"], "Ağlama")
        self.assertIn("1998/ Flört bitince gözler kapaklarını açtı ve damlalar gelmeye başladı", story)
        self.assertNotIn("açtığı", story)


if __name__ == "__main__":
    unittest.main(verbosity=2)
