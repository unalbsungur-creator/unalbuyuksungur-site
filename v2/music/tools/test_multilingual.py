"""TR/EN/DE static routes, metadata, accessibility, fallback and shared catalog checks."""

import json
import html
import shutil
import subprocess
import unittest
from pathlib import Path

import render_site

ROOT = Path(__file__).resolve().parents[3]
CATALOG = json.loads((ROOT / "v2/music/data/catalog.json").read_text(encoding="utf-8"))
SOURCES = {p: (ROOT / p).read_bytes() for p in (
    "v2/index.html", "v2/music/index.html", "v2/music/work/index.html",
    "v2/i18n/config.json", "v2/i18n/tr.json", "v2/i18n/en.json", "v2/i18n/de.json")}


class MultilingualTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pages = render_site.render(CATALOG, SOURCES)

    def test_key_parity_fallback_and_locale_constraints(self):
        config, messages = render_site.load_messages(SOURCES.__getitem__)
        self.assertEqual((config["locales"], config["default"]), (["tr", "en", "de"], "tr"))
        self.assertEqual(len({frozenset(m) for m in messages.values()}), 1)
        self.assertEqual(render_site.lookup({"tr": messages["tr"], "en": {}}, "en", "common.music"), "Müzik")
        broken = dict(SOURCES)
        broken["v2/i18n/en.json"] = b"{}"
        with self.assertRaisesRegex(render_site.LocaleError, "I18N-KEYS"):
            render_site.load_messages(broken.__getitem__)

    def test_static_locales_and_metadata(self):
        ids = {w["id"] for w in CATALOG["works"]}
        self.assertEqual(len(ids), 68)
        self.assertEqual(len(self.pages), 210)  # Turkish: 68; EN/DE: 68 works + 3 shells each.
        for locale in ("en", "de"):
            home = self.pages[f"v2/{locale}/index.html"].decode("utf-8")
            catalog = self.pages[f"v2/{locale}/music/index.html"].decode("utf-8")
            for page, route in ((home, ""), (catalog, "music/")):
                with self.subTest(locale=locale, route=route):
                    self.assertIn(f'<html lang="{locale}">', page)
                    self.assertIn(f'<link rel="canonical" href="{render_site.locale_url(locale, route)}">', page)
                    self.assertIn(f'content="{ "en_US" if locale == "en" else "de_DE" }"', page)
                    self.assertEqual(page.count('rel="alternate" hreflang='), 3)
                    self.assertIn('X-Robots-Tag: noindex',
                                  __import__('build_publication').GENERATED['_headers'])
                    self.assertEqual(page.count('class="language-switcher"'), 1)
                    self.assertEqual(page.count('aria-current="true"'), 1)
            self.assertIn("Digital Projects" if locale == "en" else "Digitale Projekte", home)
            self.assertEqual(home.count('<article class="project-card">'), 6)
            self.assertIn("A wall for ideas" if locale == "en" else "Pinnwand für Gedanken", home)
            self.assertIn('href="music/"', home)
            self.assertIn('href="../../music/catalog.css"', catalog)
            self.assertIn('src="../../music/catalog.js"', catalog)
            for work_id in ids:
                page = self.pages[f"v2/{locale}/music/work/{work_id}.html"].decode("utf-8")
                self.assertIn(f'<html lang="{locale}" data-work-id="{work_id}">', page)
                self.assertIn(f'<link rel="canonical" href="{render_site.locale_url(locale, "music/work/" + work_id)}">', page)
                self.assertEqual(page.count('rel="alternate" hreflang='), 3)
                self.assertIn('src="../../../music/work/work.js"', page)
                self.assertIn('src="../../../i18n/runtime.js"', page)

    def test_work_creative_content_unchanged(self):
        ids = {w["id"]: w for w in CATALOG["works"]}
        videos = [r["videos"][0]["videoId"] for r in CATALOG["recordings"]]
        self.assertEqual((len(ids), len(videos), len(set(videos))), (68, 68, 68))
        for work_id, work in ids.items():
            for locale in ("tr", "en", "de"):
                prefix = "" if locale == "tr" else locale + "/"
                page = self.pages[f"v2/{prefix}music/work/{work_id}.html"].decode("utf-8")
                self.assertIn(work["title"], html.unescape(page))
                self.assertIn('data-work-id="' + work_id + '"', page)
            for asset in ("lyrics", "story"):
                self.assertTrue((ROOT / "v2/music" / work[asset]["file"]).is_file())

    @unittest.skipUnless(shutil.which("node"), "Node.js required for runtime behavior smoke")
    def test_runtime_choice_storage_keyboard_native_links_and_url_mapping(self):
        runtime = (ROOT / "v2/i18n/runtime.js").read_text(encoding="utf-8")
        node = r'''
            const vm = require('node:vm');
            const source = process.argv[1];
            const links = ['tr', 'en', 'de'].map(locale => ({ locale, attrs: {}, events: {},
                getAttribute(k) { return k === 'data-locale' ? this.locale : this.attrs[k]; },
                setAttribute(k, v) { this.attrs[k] = v; },
                removeAttribute(k) { delete this.attrs[k]; },
                addEventListener(k, fn) { this.events[k] = fn; }
            }));
            let ready;
            const saved = {};
            const document = { currentScript: {src: 'https://example.test/v2/i18n/runtime.js'},
                addEventListener(k, fn) { if (k === 'DOMContentLoaded') ready = fn; },
                querySelectorAll() { return links; } };
            const window = { location: { pathname: '/v2/en/music/work/w-0014.html', search: '?dil=de', hash: '#lyrics' },
                localStorage: { getItem(k) { return saved[k] || null; }, setItem(k, v) { saved[k] = v; } },
                navigator: { language: 'de' } };
            vm.runInNewContext(source, { document, window, URL });
            if (window.UNAL_UI.locale !== 'en' || window.UNAL_UI.preference() !== 'tr') throw Error('URL/fallback');
            ready();
            if (links[1].attrs['aria-current'] !== 'true' || links[0].attrs['aria-current']) throw Error('selection');
            if (links[2].href !== '/v2/de/music/work/w-0014.html?dil=de#lyrics') throw Error('route');
            links[2].events.click();
            if (window.UNAL_UI.preference() !== 'de') throw Error('preference');
            if (window.UNAL_UI.destination('xx') !== '/v2/music/work/w-0014.html?dil=de#lyrics') throw Error('fallback');
            window.localStorage.getItem = () => { throw Error('blocked'); };
            if (window.UNAL_UI.preference() !== 'tr') throw Error('storage fallback');
        '''
        result = subprocess.run([shutil.which("node"), "-e", node, runtime], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
