#!/usr/bin/env python3
"""Görev 40: "Video Klip" oynatma listesindeki 49 videonun kayıt eşleştirmesi için regresyon testi (unittest, yalnızca okur).

Tek yetkili kaynak kanalın "Video Klip" oynatma listesidir (49 video). Eşleştirmeler Görev 39 envanteri ve kullanıcı
kararlarıyla verildi; aşağıdaki tablo verify_content_integrity.VIDEO_DECISIONS'tan bağımsız yazılmıştır ve ikisi de
katalogla karşılaştırılır. Video Recording düzeyindedir; aynı eserin farklı versiyonları ayrı videolara bağlıdır.

Kullanım:
    python v2/music/tools/test_playlist_videos.py
"""

import hashlib
import json
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True  # v2/ altında __pycache__ oluşmasın (herkese açık klasör)
sys.path.insert(0, str(Path(__file__).resolve().parent))

from validate_catalog import video_problems  # noqa: E402
from verify_content_integrity import CONTENT_SHA256, VIDEO_DECISIONS  # noqa: E402

MUSIC_ROOT = Path(__file__).resolve().parent.parent
CATALOG = json.loads((MUSIC_ROOT / "data" / "catalog.json").read_text(encoding="utf-8"))
WORKS = {w["id"]: w for w in CATALOG["works"]}
RECORDINGS = {r["id"]: r for r in CATALOG["recordings"]}

# (liste sırası, video kimliği, eser, kayıt)
PLAYLIST = [
    (1, "1_HWDHh0stg", "w-0031", "r-0032"),  # Günleri Saya Saya
    (2, "G5RS_E5hmjE", "w-0050", "r-0052"),  # Sebebi Sensin
    (3, "E5uvkGpOqTo", "w-0028", "r-0029"),  # Elimi Sıktın
    (4, "_ljZcwuJvWU", "w-0013", "r-0013"),  # Benimle Yaşlanacaktın
    (5, "s84iajTL2aQ", "w-0063", "r-0067"),  # Yoksun Ama...
    (6, "z5csFSoSli8", "w-0011", "r-0011"),  # Beni Sal
    (7, "1KhGHDbMMGQ", "w-0052", "r-0054"),  # Sonsuza Kadar (listede "Galatasaray Marşı"; kullanıcı kararı)
    (8, "1_uIKEFU5J8", "w-0021", "r-0022"),  # Bugün Benim Doğum Günüm
    (9, "-3WL0gfweKo", "w-0016", "r-0017"),  # Bir Kedim Var
    (10, "ZUu-K_Qmli8", "w-0027", "r-0028"),  # Eksilmeyen
    (11, "fAmjDqgBOPU", "w-0032", "r-0033"),  # Haberleşiriz
    (12, "VaKBbcUp5RQ", "w-0056", "r-0059"),  # Turizmci (özgün kayıt)
    (13, "F-mRzZU-2fI", "w-0067", "r-0058"),  # Turizmci (Pop Versiyon)
    (14, "HNKMM9pfTJ8", "w-0003", "r-0003"),  # Angaralı Hasret
    (15, "_huavYSid-8", "w-0030", "r-0031"),  # Gece Olunca
    (16, "LUjBENG76ZA", "w-0042", "r-0043"),  # Kendimi Arıyorum
    (17, "wE9b3MR37IE", "w-0033", "r-0034"),  # Hafta
    (18, "q1zwOKY3Ymk", "w-0026", "r-0027"),  # Du bist der Grund
    (19, "GvXRUO-vPsA", "w-0058", "r-0061"),  # Wegen Dir
    (20, "xZ5bDIskUVA", "w-0046", "r-0047"),  # Mutlu Yıllar
    (21, "zTtH67AFB5U", "w-0037", "r-0038"),  # Ich meld' mich...
    (22, "H6MG3MK7oEc", "w-0057", "r-0060"),  # Türbülans
    (23, "MKnTF1jkwwY", "w-0015", "r-0016"),  # Bir Güzel Sevdim
    (24, "AqUwsEjYzaA", "w-0047", "r-0048"),  # Nerdesin
    (25, "O00SvlTK7UM", "w-0019", "r-0020"),  # Boşver Geç
    (26, "kiMxnPIWF1Q", "w-0029", "r-0030"),  # Fishka
    (27, "m1RDa0-8338", "w-0035", "r-0036"),  # Haydi Dene
    (28, "aHjCAyxfZeI", "w-0054", "r-0056"),  # Tebessümler Yüzümde
    (29, "t_-m6kXBRzk", "w-0065", "r-0014"),  # Biliyorum (Rock Ballad Version)
    (30, "1kW3WenFU5o", "w-0051", "r-0053"),  # Seninle
    (31, "NDLHL_8sCZk", "w-0039", "r-0040"),  # Kabuğumu Bıraktım
    (32, "PGvPgywoiWU", "w-0023", "r-0024"),  # Çat Çat Çat
    (33, "3Mcc6SnIrs4", "w-0043", "r-0044"),  # Kiminle
    (34, "U4Y7UcDhEmY", "w-0022", "r-0023"),  # Çarpıldım Sana
    (35, "UmwBKxmgsFs", "w-0048", "r-0049"),  # Neredeyim Ben
    (36, "TtxuK4xdhUU", "w-0007", "r-0007"),  # Babalar Günü
    (37, "oDxRo89ih-0", "w-0062", "r-0066"),  # Yine Üşüyorum
    (38, "lJTRetMuCzk", "w-0064", "r-0068"),  # Yoksun
    (39, "0tni7CybqP8", "w-0036", "r-0037"),  # Haziran
    (40, "c2HxZlyjlmA", "w-0053", "r-0055"),  # Söz Verdim
    (41, "OYm6z7ehzKE", "w-0012", "r-0012"),  # Beni Yâr Seçtin
    (42, "KuogkPvK2PM", "w-0024", "r-0025"),  # Çekip Gittin
    (43, "L7TthTFzoWM", "w-0061", "r-0064"),  # Yenik Yüreğim (Pop Version)
    (44, "pklgS71VhRc", "w-0034", "r-0035"),  # Hasret Bitecek
    (45, "n8tlmkgthQU", "w-0068", "r-0065"),  # Yenik Yüreğim (Thrash Metal Version)
    (46, "7c21yJVIsJc", "w-0025", "r-0026"),  # Çok Sevince İnsanı (Görev 36)
    (47, "wIMBBZnc7J0", "w-0040", "r-0041"),  # Kahve Falı
    (48, "0BMN6o_hJUw", "w-0010", "r-0010"),  # Ben Boğa'yım
    (49, "tVrZGaPSRTw", "w-0004", "r-0004"),  # Anneler Günü
]
# Görev 40 kullanıcı kararları (Görev 39'da MEDIUM / AMBIGUOUS / UNMATCHED): sıra -> kayıt başlığı
USER_DECISIONS = {7: "Sonsuza Kadar", 14: "Angaralı Hasret", 20: "Mutlu Yıllar", 24: "Nerdesin",
                  29: "Biliyorum (Rock Ballad Version)", 36: "Babalar Günü", 40: "Söz Verdim", 41: "Beni Yâr Seçtin",
                  43: "Yenik Yüreğim (Pop Version)", 44: "Hasret Bitecek", 48: "Ben Boğa'yım"}
WITHOUT_VIDEO = ["r-0001", "r-0002", "r-0005", "r-0006", "r-0008", "r-0009", "r-0015", "r-0018", "r-0019", "r-0021",
                 "r-0039", "r-0042", "r-0045", "r-0046", "r-0050", "r-0051", "r-0057", "r-0062", "r-0063"]
VIDEO = lambda vid: [{"provider": "youtube", "videoId": vid, "videoType": "official-music-video"}]  # noqa: E731


def by_order(order):
    return next(row for row in PLAYLIST if row[0] == order)


class PlaylistTableTests(unittest.TestCase):
    def test_playlist_has_49_unique_videos_on_49_recordings(self):
        self.assertEqual([row[0] for row in PLAYLIST], list(range(1, 50)))
        self.assertEqual(len({row[1] for row in PLAYLIST}), 49)
        self.assertEqual(len({row[3] for row in PLAYLIST}), 49)

    def test_table_matches_integrity_decisions(self):
        self.assertEqual({rid: vid for _, vid, _, rid in PLAYLIST}, VIDEO_DECISIONS)

    def test_recordings_belong_to_listed_works(self):
        for order, _, wid, rid in PLAYLIST:
            self.assertEqual(RECORDINGS[rid]["workId"], wid, f"#{order}")


class CatalogVideoTests(unittest.TestCase):
    def test_catalog_has_exactly_the_49_playlist_videos(self):
        on_catalog = {rid: r["videos"] for rid, r in RECORDINGS.items() if "videos" in r}
        self.assertEqual(on_catalog, {rid: VIDEO(vid) for _, vid, _, rid in PLAYLIST})
        self.assertEqual(video_problems(RECORDINGS), [])

    def test_existing_video_preserved_and_48_new(self):
        self.assertEqual(RECORDINGS["r-0026"]["videos"], VIDEO("7c21yJVIsJc"))
        self.assertEqual(by_order(46), (46, "7c21yJVIsJc", "w-0025", "r-0026"))
        self.assertEqual(sum(1 for row in PLAYLIST if row[3] != "r-0026"), 48)

    def test_19_recordings_without_video(self):
        self.assertEqual(sorted(rid for rid, r in RECORDINGS.items() if "videos" not in r), WITHOUT_VIDEO)

    def test_counts_preserved(self):
        self.assertEqual((len(WORKS), len(RECORDINGS), len(CATALOG["covers"])), (68, 68, 68))

    def test_galatasaray_marsi_goes_to_sonsuza_kadar(self):
        _, vid, wid, rid = by_order(7)
        self.assertEqual((vid, WORKS[wid]["title"], RECORDINGS[rid]["title"]), ("1KhGHDbMMGQ", "Sonsuza Kadar", "Sonsuza Kadar"))
        self.assertEqual(RECORDINGS[rid]["videos"], VIDEO(vid))

    def test_user_decisions(self):
        for order, title in USER_DECISIONS.items():
            _, vid, _, rid = by_order(order)
            with self.subTest(order=order):
                self.assertEqual(RECORDINGS[rid]["title"], title)
                self.assertEqual(RECORDINGS[rid]["videos"], VIDEO(vid))

    def test_versions_not_mixed(self):
        # sıra -> (kayıt, isOriginal, versionLabel)
        expected = {12: ("r-0059", True, None), 13: ("r-0058", False, "Pop Versiyon"),
                    29: ("r-0014", False, "Rock Ballad Version"), 43: ("r-0064", True, "Pop Version"),
                    45: ("r-0065", False, "Thrash Metal Version")}
        for order, (rid, original, label) in expected.items():
            _, vid, _, row_rid = by_order(order)
            recording = RECORDINGS[rid]
            with self.subTest(order=order):
                self.assertEqual(row_rid, rid)
                self.assertEqual((recording["isOriginal"], recording["versionLabel"]), (original, label))
                self.assertEqual(recording["videos"], VIDEO(vid))
        self.assertNotIn("videos", RECORDINGS["r-0015"], "#29 yalnızca Rock Ballad kaydına aittir; Biliyorum Pop kaydına kopyalanmaz")

    def test_high_confidence_matches(self):
        high = [row for row in PLAYLIST if row[0] not in USER_DECISIONS and row[0] != 46]
        self.assertEqual(len(high), 37)
        for order, vid, _, rid in high:
            self.assertEqual(RECORDINGS[rid]["videos"], VIDEO(vid), f"#{order}")


class ContentIntegrityTests(unittest.TestCase):
    def test_lyrics_and_story_hashes(self):
        for path, digest in CONTENT_SHA256.items():
            self.assertEqual(hashlib.sha256((MUSIC_ROOT / path).read_bytes()).hexdigest(), digest, path)

    def test_cover_webp_hashes(self):
        images = [image for cover in CATALOG["covers"] for image in cover["webImages"]]
        self.assertEqual(len(images), 204)
        for image in images:
            self.assertEqual(hashlib.sha256((MUSIC_ROOT / image["path"]).read_bytes()).hexdigest(), image["sha256"], image["path"])

    def test_listen_links_untouched_by_videos(self):
        for rid, recording in RECORDINGS.items():
            if "videos" in recording:
                self.assertIsNone(recording["links"]["youtube"], rid)


if __name__ == "__main__":
    unittest.main(verbosity=2)
