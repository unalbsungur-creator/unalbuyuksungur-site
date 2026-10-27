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

    @unittest.skipUnless(shutil.which("node"), "Node.js required for work-page behavior smoke")
    def test_listen_links_are_recording_specific_safe_and_conditional(self):
        source = (ROOT / "v2/music/work/work.js").read_text(encoding="utf-8")
        template = (ROOT / "v2/music/work/index.html").read_text(encoding="utf-8")
        style = (ROOT / "v2/music/work/work.css").read_text(encoding="utf-8")
        self.assertIn('id="work-listen-section" aria-labelledby="listen-title" hidden', template)
        self.assertNotIn("Dinleme bağlantıları yakında eklenecek", source + template)
        self.assertIn("@media (max-width: 560px)", style)
        self.assertIn(".listen-links .button {\n        width: 100%;", style)
        recording = next(r for r in CATALOG["recordings"] if r["links"]["spotify"])
        messages = {loc: json.loads((ROOT / f"v2/i18n/{loc}.json").read_text(encoding="utf-8"))
                    for loc in ("tr", "en", "de")}
        titles = {"tr": "Müzik Platformlarında Dinle", "en": "Listen on Music Platforms",
                  "de": "Auf Musikplattformen anhören"}
        for locale, title in titles.items():
            self.assertEqual(messages[locale]["music.listenPlatforms"], title)
            page = template if locale == "tr" else self.pages[f"v2/{locale}/music/work/{recording['workId']}.html"].decode("utf-8")
            self.assertIn(f'id="listen-title">{title}</h2>', page)
        platform_code = source[source.index("var LISTEN_PLATFORMS = ["):]
        platform_code = platform_code[:platform_code.index("];\n") + 2]
        url_code = source[source.index("function isHttpsUrl("):source.index("/* ---------- Görseller")]
        listen_code = source[source.index("function renderListen("):source.index("// Seçili kaydın ilk geçerli videosu")]
        smoke_source = platform_code + url_code + listen_code
        small_messages = {loc: {key: value for key, value in entries.items()
                                if key in ("music.spotifyListen", "music.appleListen", "music.youtubeMusicListen", "music.newTab")}
                          for loc, entries in messages.items()}
        node = r'''
            const vm = require('node:vm');
            const source = process.argv[1];
            const recording = JSON.parse(process.argv[2]);
            const messages = JSON.parse(process.argv[3]);
            for (const locale of ['tr', 'en', 'de']) {
                const dom = {listenSection: {hidden: true}, listen: {nodes: [], replaceChildren(...nodes) { this.nodes = nodes; }}};
                const context = {URL, dom, tr: (key, fallback) => messages[locale][key] || fallback,
                    el: (tag, attrs, children = []) => ({tag, attrs, children})};
                vm.runInNewContext(source + '\nthis.run = renderListen;', context);
                const work = {recordings: [recording]};
                const empty = {...recording, links: {spotify: null, appleMusic: null, youtubeMusic: null,
                    youtube: 'https://www.youtube.com/watch?v=abcDEF12345', other: []}};
                context.run(work, empty);
                if (!dom.listenSection.hidden || dom.listen.nodes.length) throw Error('empty section must disappear');
                context.run(work, recording);
                const anchors = dom.listen.nodes[0].children.map(item => item.children[0]);
                if (dom.listenSection.hidden || anchors.length !== 3) throw Error('missing direct links');
                if (anchors.some(a => a.attrs.href !== recording.links[
                    a.attrs.text.includes('Spotify') ? 'spotify' : a.attrs.text.includes('Apple') ? 'appleMusic' : 'youtubeMusic'])) throw Error('wrong destination');
                if (anchors.some(a => a.attrs.target !== '_blank' || a.attrs.rel !== 'noopener noreferrer' || !a.children.length)) throw Error('unsafe navigation');
                const bad = {...recording, links: {...recording.links, spotify: 'https://open.spotify.com/artist/0123456789abcdefABCDEF',
                    appleMusic: 'https://music.apple.com/us/artist/example/123', youtubeMusic: 'https://www.youtube.com/watch?v=abcDEF12345'}};
                context.run(work, bad);
                if (!dom.listenSection.hidden || dom.listen.nodes.length) throw Error('artist/video links rendered');
                context.run(work, {...recording, links: {...recording.links, spotify: 'https://open.spotify.com.evil.test/track/0123456789abcdefABCDEF', appleMusic: '', youtubeMusic: null}});
                if (!dom.listenSection.hidden) throw Error('malformed link rendered');
                context.run(work, {...recording, links: {...recording.links, spotify: null, youtubeMusic: null}});
                if (dom.listenSection.hidden || dom.listen.nodes[0].children.length !== 1 || dom.listen.nodes[0].children[0].children[0].attrs.href !== recording.links.appleMusic) throw Error('single link');
            }
        '''
        result = subprocess.run([shutil.which("node"), "-e", node, smoke_source,
                                 json.dumps({"links": recording["links"], "workId": recording["workId"]}),
                                 json.dumps(small_messages)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

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
