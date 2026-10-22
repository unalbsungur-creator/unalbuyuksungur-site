#!/usr/bin/env python3
"""Görev 59: onaylı V2 dış bağlantılarının kaynak, kullanım ve güvenlik regresyonları."""

import re
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[3]
SOURCE = (ROOT / "v2/external-links.js").read_text(encoding="utf-8")
PAGES = {
    "home": (ROOT / "v2/index.html").read_text(encoding="utf-8"),
    "catalog": (ROOT / "v2/music/index.html").read_text(encoding="utf-8"),
    "work": (ROOT / "v2/music/work/index.html").read_text(encoding="utf-8"),
}

EXPECTED = {
    "linkedin": "https://www.linkedin.com/in/ünal-büyüksungur-9ba3489b",
    "instagram": "https://www.instagram.com/unalbuyuksungurmusic/",
    "facebook": "https://www.facebook.com/unalbsungur/",
    "youtube": "https://www.youtube.com/@UnalBuyuksungurMusic",
    "tiktok": "https://www.tiktok.com/@unal.buyuksungur",
    "spotify": "https://open.spotify.com/intl-tr/artist/57rcIXBqGaiGj9bje71Jkz?si=joU3pNjdQIuA9-UHTwq42Q",
    "youtubeMusic": "https://music.youtube.com/@unalbuyuksungurmusic",
    "appleMusic": "https://music.apple.com/us/artist/%C3%BCnal-b%C3%BCy%C3%BCksungur/1868323918",
    "blog": "https://unalbsungur.blogspot.com/",
    "shopier": "https://www.shopier.com/unalbuyuksungur/",
}


def source_links():
    return dict(re.findall(r'^\s{8}(\w+): Object\.freeze\(\{[^\n]* url: "([^"]+)" \}\)', SOURCE, re.MULTILINE))


class ExternalLinksTests(unittest.TestCase):
    def test_canonical_source_is_exactly_the_approved_allowlist(self):
        self.assertEqual(source_links(), EXPECTED)
        self.assertNotIn("etsy", SOURCE.lower())
        self.assertNotRegex(SOURCE.lower(), r"mailto:|tel:")

    def test_pages_use_the_single_canonical_source(self):
        self.assertIn('src="external-links.js"', PAGES["home"])
        self.assertIn('src="../external-links.js"', PAGES["catalog"])
        self.assertIn('src="../../external-links.js"', PAGES["work"])
        all_html = "\n".join(PAGES.values())
        for key, url in EXPECTED.items():
            self.assertIn(f'data-external-link="{key}"', all_html, key)
            self.assertNotIn(url, all_html, f"{key}: URL HTML'de tekrar edilmemeli")

    def test_required_placements_and_exclusions(self):
        home = PAGES["home"]
        catalog = PAGES["catalog"]
        for key in ("linkedin", "instagram", "facebook", "tiktok"):
            self.assertRegex(home, rf'<a class="social-link" data-external-link="{key}"')
        for key in ("spotify", "youtubeMusic", "appleMusic", "youtube"):
            self.assertRegex(catalog, rf'<a class="platform-link" data-external-link="{key}"')
        self.assertRegex(home, r'id="yazilar"[\s\S]*?data-external-link="blog"')
        self.assertRegex(home, r'id="magaza"[\s\S]*?data-external-link="shopier"')
        self.assertNotRegex(home.lower(), r"etsy|mailto:|tel:|iletişim formu")

    def test_runtime_applies_external_link_security_and_accessible_names(self):
        self.assertIn('anchor.target = "_blank"', SOURCE)
        self.assertIn('anchor.rel = "noopener noreferrer"', SOURCE)
        self.assertIn('anchor.setAttribute("aria-label"', SOURCE)
        for name, html in PAGES.items():
            anchors = re.findall(r'<a class="(?:social-link|platform-link|shop-link|footer-link|stop-link external-stop-link)"[^>]*>', html)
            self.assertTrue(anchors, name)
            for anchor in anchors:
                self.assertIn("data-external-link=", anchor, f"{name}: {anchor}")
                self.assertIn("data-external-label=", anchor, f"{name}: {anchor}")

    def test_preserved_catalog_invariants(self):
        catalog = (ROOT / "v2/music/data/catalog.json").read_text(encoding="utf-8")
        self.assertEqual(len(re.findall(r'"id": "w-\d{4}"', catalog)), 68)
        self.assertEqual(len(re.findall(r'"id": "r-\d{4}"', catalog)), 68)
        self.assertEqual(len(re.findall(r'"videoId": "[A-Za-z0-9_-]{11}"', catalog)), 49)


if __name__ == "__main__":
    unittest.main(verbosity=2)
