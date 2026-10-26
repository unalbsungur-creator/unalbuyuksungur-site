#!/usr/bin/env python3
"""Statik eser sayfası oluşturucusunun testi (unittest, yalnızca okur; dosya yazmaz).

Görev 73: render_pages.py her eser için şablondan bir sayfa üretir. Beklenen metadata bu testte katalogdan,
oluşturucunun fonksiyonları çağrılmadan yeniden hesaplanır; üretilen HTML ayrıştırılarak karşılaştırılır.
Hatalı veri, şablon bozukluğu ve zararlı metin girdileri de denenir.

Kullanım:
    python v2/music/tools/test_render_pages.py
"""

import copy
import json
import re
import sys
import unittest
from html.parser import HTMLParser
from pathlib import Path

sys.dont_write_bytecode = True  # v2/ altında __pycache__ oluşmasın (herkese açık klasör)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_pages as rp  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
CATALOG = json.loads((REPO / "v2/music/data/catalog.json").read_text(encoding="utf-8"))
TEMPLATE = (REPO / rp.TEMPLATE).read_bytes()
BASE = "https://unalbuyuksungur-v2.pages.dev/v2/"
LANG = {"tr": "Türkçe", "de": "Almanca"}


class Head(HTMLParser):
    """Head etiketleri: her ad için bütün değerler (tekrarlar görünsün diye liste)."""

    def __init__(self):
        super().__init__()
        self.tags = {}
        self.html_attrs = {}
        self._in_title = False

    def add(self, key, value):
        self.tags.setdefault(key, []).append(value)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "html":
            self.html_attrs = attrs
        elif tag == "title":
            self._in_title = True
            self.add("title", "")
        elif tag == "meta" and "content" in attrs:
            self.add(attrs.get("name") or attrs.get("property"), attrs["content"])
        elif tag == "link" and attrs.get("rel") == "canonical":
            self.add("canonical", attrs["href"])

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.tags["title"][-1] += data


def parse(page):
    head = Head()
    head.feed(page.decode("utf-8"))
    return head


def expected(work):
    """Beklenen metadata, katalog alanlarından doğrudan (render_pages fonksiyonları kullanılmadan)."""
    recs = sorted((r for r in CATALOG["recordings"] if r["workId"] == work["id"]),
                  key=lambda r: (r.get("isOriginal") is not True, r["id"]))
    cover = next(c for c in CATALOG["covers"] if c["id"] == recs[0]["coverId"])
    image = next(i for i in cover["webImages"] if i["width"] == 1200)
    cols = [c["title"] for c in sorted(CATALOG["collections"], key=lambda c: c["order"])
            if any(m["workId"] == work["id"] for m in c["members"])]
    text = f"Ünal Büyüksungur'un {LANG[work['language']]} eseri “{work['title']}”."
    if cols:
        text += " " + ", ".join(cols) + " koleksiyonunda."
    if recs[0].get("videos"):
        text += " Şarkı sözleri, hikâyesi ve video klibi bu sayfada."
    else:
        text += " Şarkı sözleri ve hikâyesi bu sayfada."
    url = BASE + "music/work/" + work["id"]
    img = BASE + "music/" + image["path"] + "?v=" + image["sha256"][:12]
    og_title = work["title"] + " | Ünal Büyüksungur"
    return {
        "title": [work["title"] + " | Müzik Dünyam | Ünal Büyüksungur"],
        "description": [text], "canonical": [url],
        "og:type": ["website"], "og:site_name": ["Ünal Büyüksungur · Digital World"], "og:locale": ["tr_TR"],
        "og:title": [og_title], "og:description": [text], "og:url": [url], "og:image": [img],
        "og:image:type": ["image/webp"], "og:image:width": ["1200"], "og:image:height": ["1200"],
        "og:image:alt": [work["title"] + " kapak görseli"],
        "twitter:card": ["summary"], "twitter:title": [og_title], "twitter:description": [text],
        "twitter:image": [img], "twitter:image:alt": [work["title"] + " kapak görseli"],
        "viewport": ["width=device-width, initial-scale=1.0"],
    }


def sample_catalog(title="Örnek Eser"):
    """Tek eserlik küçük katalog (gerçek katalogdan kopyalanan alanlarla)."""
    work = copy.deepcopy(CATALOG["works"][0])
    rec = copy.deepcopy(next(r for r in CATALOG["recordings"] if r["workId"] == work["id"]))
    cover = copy.deepcopy(next(c for c in CATALOG["covers"] if c["id"] == rec["coverId"]))
    work["title"] = title
    return {"works": [work], "recordings": [rec], "covers": [cover], "collections": []}


class RenderPagesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pages = rp.render_work_pages(CATALOG, TEMPLATE)

    def assert_error(self, code, catalog=None, template=TEMPLATE, profile="preview"):
        with self.assertRaises(rp.RenderError) as ctx:
            rp.render_work_pages(catalog if catalog is not None else CATALOG, template, profile)
        self.assertIn(code, str(ctx.exception))

    # --- Gerçek katalog ---

    def test_inventory(self):
        self.assertEqual(len(CATALOG["works"]), 68)
        self.assertEqual(len(CATALOG["recordings"]), 68)
        self.assertEqual(len(CATALOG["covers"]), 68)
        with_video = sum(1 for r in CATALOG["recordings"] if r.get("videos"))
        self.assertEqual((with_video, 68 - with_video), (68, 0))

    def test_68_pages_with_expected_paths(self):
        ids = sorted(w["id"] for w in CATALOG["works"])
        self.assertEqual(len(set(ids)), 68)
        self.assertEqual(list(self.pages), [f"v2/music/work/{i}.html" for i in ids])

    def test_metadata_matches_catalog_for_every_work(self):
        for work in CATALOG["works"]:
            with self.subTest(work=work["id"]):
                head = parse(self.pages[f"v2/music/work/{work['id']}.html"])
                self.assertEqual(head.tags, expected(work))
                self.assertEqual(head.html_attrs, {"lang": "tr", "data-work-id": work["id"]})

    def test_metadata_unique_across_pages(self):
        heads = [parse(p).tags for p in self.pages.values()]
        for key in ("title", "description", "canonical", "og:title", "og:url", "og:image", "twitter:title"):
            values = [h[key][0] for h in heads]
            self.assertEqual(len(set(values)), 68, key)

    def test_no_invented_facts(self):
        for page in self.pages.values():
            # Eser adının kendisi (ör. "Biliyorum (Rock Ballad Version)") katalogdan gelir; adın dışı denetlenir.
            description = re.sub(r"“[^”]*”", "“”", parse(page).tags["description"][0])
            self.assertNotRegex(description, r"\d{4}|[Pp]op|[Rr]ock|[Mm]etal|[Oo]rijinal|[Yy]ayın")

    def test_body_identical_to_template(self):
        template = TEMPLATE.decode("utf-8")
        start = template.index("<!-- Aşağıdaki varsayılanlar")
        end = template.index("\n", template.index('property="og:description"'))
        for rel, page in self.pages.items():
            text = page.decode("utf-8")
            work_id = rel[-11:-5]
            self.assertTrue(text.startswith(template[:start].replace(
                '<html lang="tr">', f'<html lang="tr" data-work-id="{work_id}">')), rel)
            self.assertTrue(text.endswith(template[end:]), rel)

    def test_real_titles_with_apostrophes_escaped(self):
        for work_id, title in (("w-0010", "Ben Boğa'yım"), ("w-0037", "Ich meld' mich...")):
            page = self.pages[f"v2/music/work/{work_id}.html"]
            self.assertIn(b"&#x27;", page)
            self.assertEqual(parse(page).tags["og:image:alt"], [title + " kapak görseli"])

    def test_deterministic_and_lf(self):
        again = rp.render_work_pages(CATALOG, TEMPLATE)
        self.assertEqual(again, self.pages)
        for page in self.pages.values():
            self.assertNotIn(b"\r", page)
            self.assertFalse(page.startswith(b"\xef\xbb\xbf"))

    def test_crlf_template_keeps_crlf(self):
        pages = rp.render_work_pages(CATALOG, TEMPLATE.replace(b"\n", b"\r\n"))
        page = pages["v2/music/work/w-0001.html"]
        self.assertNotIn(b"\n", page.replace(b"\r\n", b""))

    # --- Escaping ---

    def test_hostile_titles_are_escaped(self):
        for title in ('"><script>alert(1)</script>', "A & B <b>kalın</b>", "Tırnak \"çift\" ve 'tek'",
                      "</title><script>x()</script>"):
            with self.subTest(title=title):
                page = rp.render_work_pages(sample_catalog(title), TEMPLATE)["v2/music/work/w-0001.html"]
                text = page.decode("utf-8")
                head = text[:text.index("</head>")]
                self.assertNotIn("<script>alert", head)
                self.assertNotIn("<script>x()", head)
                self.assertNotIn("<b>", head)
                tags = parse(page).tags
                self.assertEqual(tags["title"], [title + " | Müzik Dünyam | Ünal Büyüksungur"])
                self.assertEqual(tags["og:title"], [title + " | Ünal Büyüksungur"])
                self.assertIn(f"“{title}”", tags["description"][0])

    # --- Hatalı veri ---

    def test_invalid_data_stops(self):
        def mutate(fn):
            catalog = copy.deepcopy(CATALOG)
            fn(catalog)
            return catalog
        cases = {
            "[SEO-DUP]": [lambda c: c["works"].append(copy.deepcopy(c["works"][0])),
                          lambda c: c["works"][1].update(title=c["works"][0]["title"])],
            "[SEO-DATA]": [lambda c: c["works"][0].update(id="w-1"),
                           lambda c: c["works"][0].update(id="../x"),
                           lambda c: c["works"][0].update(title="", workingTitle=None),
                           lambda c: c["works"][0].update(title="A\nB"),
                           lambda c: c["works"][0].update(title=" Boşluk"),
                           lambda c: c["works"][0].update(title="x" * 201),
                           lambda c: c["works"][0].update(language="en"),
                           lambda c: c["recordings"].pop(0),
                           lambda c: c["covers"].pop(0),
                           lambda c: c["covers"][0].update(webImages=[]),
                           lambda c: c["covers"][0]["webImages"][2].update(path="../tools/x.webp"),
                           lambda c: c["covers"][0]["webImages"][2].update(path="https://evil.example/x.webp"),
                           lambda c: c["covers"][0]["webImages"][2].update(sha256="xyz"),
                           lambda c: c["covers"][0]["webImages"][2].update(format="svg"),
                           lambda c: c["covers"].append(copy.deepcopy(c["covers"][0])),
                           lambda c: c.pop("collections")],
        }
        for code, fns in cases.items():
            for index, fn in enumerate(fns):
                with self.subTest(code=code, case=index):
                    self.assert_error(code, mutate(fn))

    def test_unknown_profile_and_no_production(self):
        self.assertEqual(set(rp.PROFILES), {"preview"})
        self.assert_error("[SEO-PROFILE]", profile="production")
        self.assertEqual(rp.profile_base("preview"), BASE)

    def test_url_guard(self):
        for bad in ("music/work/../../x", "music/work/./x", "music/work/x#frag"):
            with self.subTest(bad=bad), self.assertRaises(rp.RenderError):
                rp.absolute(BASE, bad)
        for bad in ("http://evil.example/", "https://user@evil.example/"):
            with self.subTest(bad=bad), self.assertRaises(rp.RenderError):
                rp.absolute(BASE, bad)

    # --- Şablon ---

    def test_template_problems_stop(self):
        text = TEMPLATE.decode("utf-8")
        title = re.search(r"\s*<title>[^<]*</title>", text).group(0)
        broken = {
            "başlık yok": text.replace(title, ""),
            "iki başlık": text.replace(title, title + title),
            "aynı satırda iki başlık": text.replace("<title>", "<title>A</title><title>", 1),
            "canonical var": text.replace("</head>", '<link rel="canonical" href="x"></head>'),
            "twitter var": text.replace("</head>", '<meta name="twitter:card" content="x"></head>'),
            "html etiketi farklı": text.replace('<html lang="tr">', '<html lang="de">'),
            "data-work-id var": text.replace('<html lang="tr">', '<html lang="tr" data-work-id="w-0001">'),
            "bölge dışında og": text.replace("</head>", '<meta property="og:title" content="x"></head>'),
            "site_name yok": re.sub(r'\s*<meta property="og:site_name"[^>]*>', "", text),
        }
        for name, template in broken.items():
            with self.subTest(name=name):
                self.assert_error("[SEO-TEMPLATE]", template=template.encode("utf-8"))
        self.assert_error("[SEO-TEMPLATE]", template=b"\xff\xfe")


if __name__ == "__main__":
    unittest.main(verbosity=2)
