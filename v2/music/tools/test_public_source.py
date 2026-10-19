#!/usr/bin/env python3
"""Herkese açık depoya giren geliştirme kaynaklarının hijyen testi (unittest, yalnızca okur).

Görev 28: v2/music/tools/ ve data/README.md GitHub'da herkese açık kaynak olarak bulunur. Bu dosyalarda
mutlak yerel yollar, kullanıcı klasörleri, kaynak Word belgesinin dosya adı ve eser kimliğine bağlı
gizlilik kararları bulunmamalıdır. Kalıplar bu dosyanın kendisiyle eşleşmeyecek biçimde parçalardan kurulur.

Kullanım:
    python v2/music/tools/test_public_source.py
"""

import re
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True  # v2/ altında __pycache__ oluşmasın (herkese açık klasör)

MUSIC_ROOT = Path(__file__).resolve().parent.parent
FILES = sorted((MUSIC_ROOT / "tools").glob("*.py")) + [MUSIC_ROOT / "data" / "README.md"]
TEXTS = {path.name: path.read_text(encoding="utf-8") for path in FILES}

DRIVE_PATH = re.compile(r"(?<![A-Za-z])[A-Za-z]:[\\/](?![\\/])")  # sürücü harfli mutlak yol (URL şeması değil)
USER_DIR = re.compile("(?i)" + "[\\\\/]" + "Us" + "ers" + "[\\\\/]")
SOURCE_NAME = re.compile("(?i)" + "şarkı sözlerim" + " hikayesi")
PRIVACY_DECISION = re.compile(r'"w-\d{4}"\s*:\s*"[^"]*(' + "sağ" + "lık|ya" + "s/|kay" + "ıp|kesin " + "tarih|kişi a" + "dı|hesab|ai" + "le/)")


class PublicSourceTests(unittest.TestCase):
    def test_scope(self):
        self.assertIn("import_song_archive.py", TEXTS)
        self.assertIn("README.md", TEXTS)

    def test_no_absolute_local_paths_or_user_dirs(self):
        for name, text in TEXTS.items():
            for pattern in (DRIVE_PATH, USER_DIR):
                hits = [m.group(0) for m in pattern.finditer(text)]
                self.assertEqual(hits, [], f"{name}: {hits[:3]}")

    def test_no_source_document_name(self):
        for name, text in TEXTS.items():
            self.assertIsNone(SOURCE_NAME.search(text), name)

    def test_no_work_level_privacy_decisions(self):
        for name, text in TEXTS.items():
            self.assertIsNone(PRIVACY_DECISION.search(text), name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
