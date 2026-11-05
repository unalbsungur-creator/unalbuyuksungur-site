"""TR/EN/DE static routes, metadata, accessibility, fallback and shared catalog checks."""

import json
import html
import re
import shutil
import subprocess
import unittest
from pathlib import Path

import render_site

ROOT = Path(__file__).resolve().parents[3]
CATALOG = json.loads((ROOT / "v2/music/data/catalog.json").read_text(encoding="utf-8"))
SOURCES = {p: (ROOT / p).read_bytes() for p in (
    "v2/index.html", "v2/music/index.html", "v2/music/work/index.html", "v2/studio/index.html",
    "v2/i18n/config.json", "v2/i18n/tr.json", "v2/i18n/en.json", "v2/i18n/de.json", *render_site.TR_PAGES)}
# Görev 228: stüdyo Shopier ürünleri (external-links.js ile birebir; test_external_links denetler).
SHOPIER = {key: "https://www.shopier.com/unalbuyuksungur/" + num for key, num in (
    ("shopierOzelSarki", "52596551"), ("shopierOzelSarkiHaftaSonu", "52596592"),
    ("shopierOzelSarkiPlus", "52596612"), ("shopierOzelSarkiPlusHaftaSonu", "52596627"))}


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
        # Turkish: 68 works + 3 rendered shells (Görev 220) + 5 Turkish-only pages (Görev 221: blog, posts,
        # privacy) + 5 draft legal pages (Görev 226); EN/DE: 68 works + 4 shells each.
        self.assertEqual(len(self.pages), 225)
        for locale in ("en", "de"):
            home = self.pages[f"v2/{locale}/index.html"].decode("utf-8")
            catalog = self.pages[f"v2/{locale}/music/index.html"].decode("utf-8")
            studio = self.pages[f"v2/{locale}/studio/index.html"].decode("utf-8")
            for page, route in ((home, ""), (catalog, "music/"), (studio, "studio/")):
                with self.subTest(locale=locale, route=route):
                    self.assertIn(f'<html lang="{locale}">', page)
                    self.assertIn(f'<link rel="canonical" href="{render_site.locale_url(locale, route, "preview")}">', page)
                    self.assertIn(f'content="{ "en_US" if locale == "en" else "de_DE" }"', page)
                    self.assertEqual(page.count('rel="alternate" hreflang='), 4)  # tr, en, de, x-default
                    self.assertIn('X-Robots-Tag: noindex',
                                  __import__('build_publication').generated("preview", {})['_headers'])
                    self.assertEqual(page.count('class="language-switcher"'), 1)
                    self.assertEqual(page.count('aria-current="true"'), 1)
            self.assertIn("Digital Projects" if locale == "en" else "Digitale Projekte", home)
            self.assertEqual(home.count('<article class="project-card">'), 6)
            self.assertIn("A wall for ideas" if locale == "en" else "Pinnwand für Gedanken", home)
            self.assertIn('href="music/"', home)
            self.assertIn('href="../../music/catalog.css"', catalog)
            self.assertIn('src="../../music/catalog.js"', catalog)
            self.assertIn('href="../../studio/studio.css"', studio)
            self.assertIn('src="../../i18n/runtime.js"', studio)
            for work_id in ids:
                page = self.pages[f"v2/{locale}/music/work/{work_id}.html"].decode("utf-8")
                self.assertIn(f'<html lang="{locale}" data-work-id="{work_id}">', page)
                self.assertIn(f'<link rel="canonical" href="{render_site.locale_url(locale, "music/work/" + work_id, "preview")}">', page)
                self.assertEqual(page.count('rel="alternate" hreflang='), 4)
                self.assertIn('src="../../../music/work/work.js"', page)
                self.assertIn('src="../../../i18n/runtime.js"', page)

    def test_shell_seo_per_profile(self):
        """Görev 220: every TR/EN/DE shell gets canonical, hreflang (x-default = TR), OG and Twitter tags."""
        production = render_site.render(CATALOG, SOURCES, "production")
        for pages, origin in ((self.pages, "https://unalbuyuksungur-v2.pages.dev/"),
                              (production, "https://unalbuyuksungur.com/")):
            for locale in ("tr", "en", "de"):
                prefix = "" if locale == "tr" else locale + "/"
                for route in ("", "music/", "studio/"):
                    page = pages["v2/" + prefix + route + "index.html"].decode("utf-8")
                    with self.subTest(origin=origin, locale=locale, route=route):
                        self.assertIn(f'<link rel="canonical" href="{origin}{prefix}{route}">', page)
                        self.assertIn(f'<link rel="alternate" hreflang="x-default" href="{origin}{route}">', page)
                        self.assertIn(f'<meta property="og:url" content="{origin}{prefix}{route}">', page)
                        self.assertIn(f'<meta property="og:image" content="{origin}images/og/'
                                      'unal-digital-world-og-1200x630.jpg">', page)
                        for tag in ('property="og:title"', 'property="og:description"', 'name="twitter:card"',
                                    'name="twitter:title"', 'name="twitter:description"', 'name="twitter:image"'):
                            self.assertEqual(page.count(tag), 1, tag)
                        self.assertNotIn("/v2/", page)
        self.assertNotIn("pages.dev", "".join(p.decode("utf-8") for p in production.values()))
        with self.assertRaisesRegex(render_site.LocaleError, "I18N-PROFILE"):
            render_site.render(CATALOG, SOURCES, "staging")

    def test_studio_packages_and_inactive_ordering(self):
        messages = {locale: json.loads((ROOT / f"v2/i18n/{locale}.json").read_text(encoding="utf-8"))
                    for locale in ("tr", "en", "de")}
        for locale in ("tr", "en", "de"):
            prefix = "" if locale == "tr" else locale + "/"
            studio = (ROOT / "v2/studio/index.html").read_text(encoding="utf-8") if locale == "tr" else \
                self.pages[f"v2/{locale}/studio/index.html"].decode("utf-8")
            with self.subTest(locale=locale):
                self.assertIn(f'<html lang="{locale}">', studio)
                m = messages[locale]
                # Görev 227/228: iki paket kartı (adlar çevrilmez), fiyatlar ve statik HTML'de etkin Shopier bağlantıları.
                self.assertEqual(studio.count('<article class="studio-package"'), 2)
                for slug, name, price, keys, product in (
                        ("ozel-sarki", "ÖZEL ŞARKI", "690 TL", ("rev3", "alt8", "mp3"), "shopierOzelSarki"),
                        ("ozel-sarki-plus", "ÖZEL ŞARKI PLUS", "990 TL", ("rev5", "alt12", "wav"),
                         "shopierOzelSarkiPlus")):
                    card = studio.split(f'<h3 id="studio-{slug}">{name}</h3>', 1)[1].split("</article>", 1)[0]
                    self.assertIn(f'<p class="studio-price">{price}</p>', card)
                    for key in keys:
                        self.assertIn(f"<li>{html.escape(m['studio.pkg.' + key], quote=False)}</li>", card)
                    links = re.findall(r'<a class="studio-buy-[a-z]+" href="([^"]+)"[^>]*'
                                       r'data-purchase-link="(\w+)">([^<]+)</a>', card)
                    self.assertEqual(links, [(SHOPIER[product], product, m["studio.buy"]),
                                             (SHOPIER[product + "HaftaSonu"], product + "HaftaSonu",
                                              m["studio.buyWeekend"])])
                    self.assertEqual(card.count('target="_blank"'), 2)
                    self.assertEqual(card.count('rel="noopener noreferrer"'), 2)
                    self.assertEqual(card.count(f'aria-describedby="studio-{slug}"'), 2)
                    self.assertNotRegex(card, r"<button\b|disabled")  # Görev 228: pasif durum kalmadı
                weekend = studio.split('<aside class="studio-weekend"', 1)[1].split("</aside>", 1)[0]
                self.assertIn('<h3 id="studio-weekend">Hafta Sonu Teslim</h3>', weekend)
                self.assertIn(html.escape(m["studio.weekendText"], quote=False), weekend)
                self.assertRegex(m["studio.weekendText"], r"9[.:]00.*18[.:]00.*990 TL.*1[.,]390 TL")
                steps = studio.split('<ol class="studio-steps">', 1)[1].split("</ol>", 1)[0]
                self.assertEqual(re.findall(r"<li>(.*?)</li>", steps),
                                 [html.escape(m[f"studio.step{i}"], quote=False) for i in range(1, 6)])
                # Bookings randevu bağlantısı yalnız ödeme sonrası e-postayla gönderilir; sayfada yayınlanmaz.
                self.assertNotRegex(studio.lower(), r"bookings|outlook\.(office|live)|office365|calendly")
                # Görev 226: SSS en altta, footer'dan hemen önce; Görev 221 kısıtları SSS dışındaki tanıtım içindir.
                faq = studio.split('<section class="studio-section studio-faq"', 1)[1].split("</section>", 1)[0]
                self.assertRegex(studio.split(faq, 1)[1], r"^</section>\s*</main>\s*<footer")
                self.assertEqual(faq.count('<details class="faq-item">'), 17)
                self.assertIn(f'<h2 id="studio-faq">{messages[locale]["studio.faq"]}</h2>', faq)
                legal = "../yasal/" if locale == "tr" else "../../yasal/"
                self.assertIn(f'href="{legal}hizmet-kosullari/">{messages[locale]["footer.legal"]}</a>', studio)
                self.assertIn(f'href="{legal}iade/">{messages[locale]["studio.faq.a14b"]}</a>'
                              f'{html.escape(messages[locale]["studio.faq.a14c"], quote=False)}', faq)
                self.assertIn('href="../music/">', faq)
                if locale != "tr":
                    for key, value in messages["tr"].items():
                        if key.startswith("studio.faq") and value != messages[locale][key]:
                            self.assertNotIn(html.escape(value, quote=False), faq, key)
                rendered = self.pages["v2/" + ("" if locale == "tr" else locale + "/") + "studio/index.html"]
                self.assertEqual(rendered.count(b'"@type":"FAQPage"'), 1 if locale == "tr" else 0)  # yalnız TR
                if locale == "tr":
                    self.assertEqual(rendered.count(b'"@type":"Question"'), 17)
                studio = studio.replace(faq, "")
                text = " ".join(html.unescape(studio).split())
                for key in ("studio.status", "studio.service.song", "studio.service.video", "studio.priceNote",
                            "studio.inc1", "studio.inc2", "studio.inc3", "studio.exc1", "studio.exc2", "studio.exc3",
                            "studio.usageText", "studio.notify", "studio.notifyText", "studio.notifyText2",
                            "studio.notifyCta"):
                    self.assertIn(m[key], text, key)
                # Görev 229: iletişim kutusu (mailto + Instagram anahtarı); açılış öncesi ifadeler kalmadı.
                self.assertIn(f'<a href="mailto:destek@unalbuyuksungur.com">destek@unalbuyuksungur.com</a>', studio)
                self.assertIn('data-external-link="instagram"', studio)
                rendered_text = rendered.decode("utf-8").lower()
                self.assertNotRegex(rendered_text, r"çok yakında|sipariş açılışından|very soon|when orders open"
                                                   r"|sehr bald|besteller")
                for attr in ('name="description"', 'property="og:description"', 'name="twitter:description"'):
                    self.assertIn(f'<meta {attr} content="{html.escape(m["studio.meta"], quote=True)}">',
                                  rendered.decode("utf-8"), attr)
                # Görev 227: eski START/PLUS/PREMIUM ve "MP3 teslim (mümkünse WAV)" kalktı; form, ödeme sayfası,
                # e-posta alanı veya iframe yok. Görev 228: sayfadaki Shopier adresleri yalnız dört ürün bağlantısı.
                self.assertNotRegex(text, r"\bSTART\b|\bPREMIUM\b|mümkünse WAV|WAV where possible|acil tarife")
                self.assertNotRegex(studio.lower(), r'<form\b|checkout|type="email"|<iframe\b')
                self.assertEqual(sorted(re.findall(r"https://www\.shopier\.com/[^\"\s<]*", studio)),
                                 sorted(SHOPIER.values()))
                # Görev 228: SSS kaynakla senkron (çalışma saati ve hafta sonu teslimi, fiyatlar).
                for key in ("studio.faq.a02", "studio.faq.a03"):
                    self.assertIn(html.escape(m[key], quote=False), faq, key)
                self.assertIn("6 çalışma saati" if locale == "tr" else
                              {"en": "6 working hours", "de": "6 Arbeitsstunden"}[locale], m["studio.faq.a02"])
                self.assertEqual(studio.count('aria-current="page"'), 1)
                self.assertIn('href="../music/"', studio)
                self.assertIn('href="./" aria-current="page"', studio)

    def test_home_music_showcase(self):
        """Görev 224: Müzik vitrini statik HTML; sayılar katalogdan, kartlar FEATURED_WORKS listesinden (eser kimliği)."""
        self.assertEqual(render_site.FEATURED_WORKS, ("w-0023", "w-0013", "w-0014", "w-0016"))
        titles = {w["id"]: w["title"] for w in CATALOG["works"]}
        expected = {"works": len(CATALOG["works"]), "recordings": len(CATALOG["recordings"]),
                    "collections": len(CATALOG["collections"])}
        for locale, prefix in (("tr", ""), ("en", "../"), ("de", "../")):
            page = self.pages["v2/" + ("" if locale == "tr" else locale + "/") + "index.html"].decode("utf-8")
            section = page.split('<section class="music-showcase" id="muzik"', 1)[1].split("</section>", 1)[0]
            with self.subTest(locale=locale):
                for key, value in expected.items():
                    self.assertIn(f'<dd data-home-stat="{key}">{value}</dd>', section)
                cards = re.findall(r'<a class="featured-work" href="music/work/(w-\d{4})\.html"><img src="([^"]+)"'
                                   r' srcset="([^"]+)"[^>]* loading="lazy"[^>]*><span>([^<]+)</span>', section)
                self.assertEqual([c[0] for c in cards], list(render_site.FEATURED_WORKS))
                for work_id, src, srcset, title in cards:
                    self.assertEqual(html.unescape(title), titles[work_id])
                    self.assertTrue(src.startswith(prefix + "music/images/c-") and src.endswith("-400.webp"), src)
                    self.assertIn("-800.webp 800w", srcset)
                self.assertEqual(len(re.findall(r'class="platform-link" data-external-link="(spotify|youtubeMusic|'
                                                r'appleMusic|youtube)"', section)), 4)
                self.assertIn('class="button button-primary music-cta" href="music/">', section)
                self.assertNotIn("Yayında", section)
                self.assertNotIn("FEATURED_WORKS", section)
        broken = dict(SOURCES)
        with self.assertRaisesRegex(render_site.LocaleError, "HOME-FEATURED"):
            original = render_site.FEATURED_WORKS
            try:
                render_site.FEATURED_WORKS = ("w-9999",)
                render_site.render(CATALOG, broken)
            finally:
                render_site.FEATURED_WORKS = original

    def test_turkish_only_pages_and_links(self):
        """Görev 221: blog, yazı ve gizlilik sayfaları yalnız TR; EN/DE sayfaları TR sayfalarına bağlanır."""
        production = render_site.render(CATALOG, SOURCES, "production")
        blog = production["v2/blog/index.html"].decode("utf-8")
        self.assertIn('<link rel="canonical" href="https://unalbuyuksungur.com/blog/">', blog)
        self.assertIn('<meta name="robots" content="noindex, follow">', blog)  # Görev 222
        self.assertIn('<meta property="og:type" content="website">', blog)
        self.assertIn('<link rel="canonical" href="https://unalbuyuksungur.com/privacy/">',
                      production["v2/privacy/index.html"].decode("utf-8"))
        for slug, url in render_site.BLOG_POSTS.items():
            post = production[f"v2/blog/{slug}/index.html"].decode("utf-8")
            self.assertIn(f'<link rel="canonical" href="{url}">', post)
            self.assertIn(f'<meta property="og:url" content="{url}">', post)
            self.assertIn('<meta property="og:type" content="article">', post)  # Görev 222
            self.assertNotIn('name="robots"', post)
            self.assertIn(f'href="{url}" target="_blank" rel="noopener">Blogda oku →</a>', post)
            self.assertIn(f'id="{slug}"', blog)
        for rel in render_site.TR_PAGES:
            self.assertNotIn("hreflang", production[rel].decode("utf-8"), rel)
        # Görev 223: not yalnız EN/DE ana sayfada; TR ana sayfada ve başlıkta "V2" yok.
        tr_home = self.pages["v2/index.html"].decode("utf-8")
        self.assertNotIn("lang-note", tr_home)
        self.assertNotIn("Yazılar Türkçedir.", tr_home)
        self.assertIn("<title>Ünal Büyüksungur | Digital World</title>", tr_home)
        self.assertNotIn("Digital World V2", "".join(p.decode("utf-8") for p in self.pages.values()))
        for locale, note in (("en", "Articles are in Turkish."), ("de", "Die Artikel sind auf Türkisch.")):
            home = self.pages[f"v2/{locale}/index.html"].decode("utf-8")
            self.assertIn(note, home)
            self.assertEqual(home.count('href="../blog/#'), 3)
            self.assertIn('href="../privacy/"', home)
            self.assertIn('href="../../privacy/"', self.pages[f"v2/{locale}/studio/index.html"].decode("utf-8"))
            self.assertIn('href="../../../privacy/"',
                          self.pages[f"v2/{locale}/music/work/w-0001.html"].decode("utf-8"))
        # Menü: Galeri yok, Mağaza var (3 dilde aynı sıra).
        for source in ("v2/index.html", "v2/music/index.html", "v2/music/work/index.html", "v2/studio/index.html",
                       *render_site.TR_PAGES):
            nav = SOURCES[source].decode("utf-8").split('<ul class="nav-list">', 1)[1].split("</ul>", 1)[0]
            visible = re.sub(r"<!--.*?-->", "", nav, flags=re.S)
            self.assertEqual(re.findall(r">([^<]+)</a>", visible),
                             ["Müzik", "Müzik Stüdyosu", "Dijital Projeler", "Yazılar", "Mağaza", "Hakkımda"], source)

    def test_studio_navigation_and_responsive_styles(self):
        for locale in ("tr", "en", "de"):
            prefix = "" if locale == "tr" else locale + "/"
            for source, route, href in (("v2/index.html", "index.html", "studio/"),
                                        ("v2/music/index.html", "music/index.html", "../studio/"),
                                        ("v2/music/work/index.html", "music/work/index.html", "../../studio/")):
                with self.subTest(locale=locale, route=route):
                    page = (ROOT / source).read_text(encoding="utf-8") if locale == "tr" else \
                        self.pages[f"v2/{prefix}{route}"].decode("utf-8")
                    self.assertIn(f'href="{href}">{ {"tr": "Müzik Stüdyosu", "en": "Music Studio", "de": "Musikstudio"}[locale]}</a>', page)
            studio = (ROOT / "v2/studio/index.html").read_text(encoding="utf-8") if locale == "tr" else \
                self.pages[f"v2/{prefix}studio/index.html"].decode("utf-8")
            for target in ("tr", "en", "de"):
                path = render_site.relative_route(f"v2/{prefix}studio/index.html", target, "studio/")
                self.assertRegex(studio, rf'<a data-locale="{target}" href="{re.escape(path)}"')
        css = (ROOT / "v2/studio/studio.css").read_text(encoding="utf-8")
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr))", css)  # Görev 227: iki paket kartı
        self.assertIn("@media (max-width: 900px)", css)
        self.assertIn("grid-template-columns: 1fr", css)
        self.assertIn("@media (max-width: 860px)", (ROOT / "v2/music/catalog.css").read_text(encoding="utf-8"))

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

    def test_music_eyebrows_and_favicon_for_every_locale(self):
        _, messages = render_site.load_messages(SOURCES.__getitem__)
        self.assertEqual((ROOT / "v2/images/favicon.jpg.jpeg").read_bytes(),
                         (ROOT / "images/favicon.jpg.jpeg").read_bytes())
        for locale in ("tr", "en", "de"):
            prefix = "" if locale == "tr" else locale + "/"
            pages = {
                "home": (ROOT / "v2/index.html").read_text(encoding="utf-8") if locale == "tr"
                else self.pages[f"v2/{locale}/index.html"].decode("utf-8"),
                "catalog": (ROOT / "v2/music/index.html").read_text(encoding="utf-8") if locale == "tr"
                else self.pages[f"v2/{locale}/music/index.html"].decode("utf-8"),
                "work": self.pages[f"v2/{prefix}music/work/w-0025.html"].decode("utf-8"),
            }
            for surface, relative in (("home", "images/" if locale == "tr" else "../images/"),
                                      ("catalog", "../images/" if locale == "tr" else "../../images/"),
                                      ("work", "../../images/" if locale == "tr" else "../../../images/")):
                self.assertIn(f'<link rel="icon" type="image/jpeg" href="{relative}favicon.jpg.jpeg">', pages[surface])
            for surface, keys in (("catalog", ("collections", "catalog")),
                                  ("work", ("work", "video", "lyrics", "story", "listen", "related", "catalog"))):
                rendered = re.findall(r'<p class="eyebrow[^\"]*">([^<]+)</p>', pages[surface])
                for key in keys:
                    with self.subTest(locale=locale, surface=surface, key=key):
                        self.assertIn(messages[locale]["music.eyebrow." + key], rendered)
                        if locale != "tr":
                            self.assertNotIn(messages["tr"]["music.eyebrow." + key], rendered)
        self.assertEqual(render_site.lookup({"tr": messages["tr"], "en": {}}, "en", "music.eyebrow.video"),
                         messages["tr"]["music.eyebrow.video"])

    @unittest.skipUnless(shutil.which("node"), "Node.js required for work-page behavior smoke")
    def test_listen_links_are_recording_specific_safe_and_conditional(self):
        source = (ROOT / "v2/music/work/work.js").read_text(encoding="utf-8")
        template = (ROOT / "v2/music/work/index.html").read_text(encoding="utf-8")
        style = (ROOT / "v2/music/work/work.css").read_text(encoding="utf-8")
        self.assertIn('id="work-listen-section" aria-labelledby="listen-title" hidden', template)
        self.assertNotIn("Dinleme bağlantıları yakında eklenecek", source + template)
        self.assertIn("@media (max-width: 560px)", style)
        self.assertIn(".listen-links .button {\n        width: 100%;", style)
        # Üç platform bağlantısı da olan kayıt (Görev 221 sonrası yalnız Spotify bağlantılı kayıtlar da var).
        recording = next(r for r in CATALOG["recordings"]
                         if all(r["links"][key] for key in ("spotify", "appleMusic", "youtubeMusic")))
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
