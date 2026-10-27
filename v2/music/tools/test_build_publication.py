#!/usr/bin/env python3
"""V2 yayın paketi oluşturucusunun güvenlik ve regresyon testi (unittest).

Görev 31: build_publication.py yalnızca allowlist'teki dosyaları bayt bayt kopyalamalı; araçlar, README,
emekli söz dosyaları ve Git yapılandırması pakete girmemeli; yol aşımı, sembolik bağ, eksik/bozuk
dosya ve beklenmeyen dosyada build durmalı ve mevcut çıktı bozulmamalı. Her test deponun geçici bir
kopyasında çalışır; gerçek kaynak dosyalara ve depo köküne hiçbir şey yazılmaz.

Kullanım:
    python v2/music/tools/test_build_publication.py
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True  # v2/ altında __pycache__ oluşmasın (herkese açık klasör)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_publication as bp  # noqa: E402

REPO = bp.DEFAULT_ROOT
SCRIPT = Path(bp.__file__).resolve()
CATALOG = json.loads((REPO / bp.CATALOG).read_text(encoding="utf-8"))
EXCLUDED = ("v2/music/data/README.md", "v2/music/content/lyrics/r-0058.txt",
            "v2/music/content/lyrics/r-0065.txt", ".gitignore", ".gitattributes")
PAGES = {f"v2/music/work/{w['id']}.html" for w in CATALOG["works"]}  # Görev 73: üretilen statik eser sayfaları
LOCALE_PAGES = {f"v2/{locale}/music/work/{w['id']}.html" for locale in ("en", "de")
                for w in CATALOG["works"]}
LOCALE_SHELLS = {f"v2/{locale}/{route}index.html" for locale in ("en", "de")
                 for route in ("", "music/", "music/work/")}
ALL_PAGES = PAGES | LOCALE_PAGES | LOCALE_SHELLS
# Görev 73 öncesindeki _headers baytları: preview noindex korunmalı, dosya birebir aynı kalmalı.
HEADERS_BEFORE = ("# build_publication.py tarafından üretildi; elle düzenlemeyin.\n/*\n  X-Robots-Tag: noindex\n"
                  "  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n").encode("utf-8")


def expected_web_files():
    """Allowlist, oluşturucudan bağımsız olarak yeniden hesaplanır."""
    files = set(bp.SITE_FILES) | {bp.CATALOG, bp.MUSIC + "data/schema.json"}
    for work in CATALOG["works"]:
        files |= {bp.MUSIC + work[k]["file"] for k in ("lyrics", "story") if work[k]["status"] == "published"}
    files |= {bp.MUSIC + i["path"] for c in CATALOG["covers"] for i in c["webImages"]}
    return files


def quiet(*_args):
    pass


class BuildPublicationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        base = Path(self._tmp.name)
        self.root = base / "repo"
        self.outside = base / "outside"
        self.outside.mkdir()
        # Deponun kopyası: V1 kök dosyaları, Git yapılandırması ve bütün izlenen V2 dosyaları (tools/ dahil).
        tracked = subprocess.run(["git", "-C", str(REPO), "ls-files", "-z"], capture_output=True,
                                 check=True).stdout.decode("utf-8").split("\0")
        for rel in filter(None, tracked):
            dest = self.root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / rel, dest)
        # Commit öncesi yerel kabulde allowlist'e yeni eklenen, henüz izlenmeyen site dosyalarını da kapsa.
        for rel in bp.SITE_FILES:
            dest = self.root / rel
            if not dest.exists():
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(REPO / rel, dest)

    def tearDown(self):
        self._tmp.cleanup()

    def build(self, out="_site", **kwargs):
        return bp.build(self.root, Path(out), log=quiet, **kwargs)

    def assert_fails(self, code, out="_site", **kwargs):
        with self.assertRaises(bp.BuildError) as ctx:
            self.build(out, **kwargs)
        self.assertIn(code, str(ctx.exception))
        leftovers = [p.name for p in self.root.iterdir() if ".staging-" in p.name or ".previous-" in p.name]
        self.assertEqual(leftovers, [], "yarım kalmış staging klasörü")

    def tree(self, out="_site"):
        base = self.root / out
        return {p.relative_to(base).as_posix(): p.read_bytes() for p in base.rglob("*") if p.is_file()}

    # --- Paket içeriği ---

    def test_output_is_exactly_the_allowlist(self):
        manifest = self.build()
        web = expected_web_files()
        self.assertEqual(len(web), 355)
        self.assertEqual(len(PAGES), 68)
        self.assertEqual(set(self.tree()), web | ALL_PAGES | set(bp.GENERATED))
        self.assertEqual(len(self.tree()), 567)
        self.assertEqual((manifest["webFiles"], manifest["copiedFiles"], manifest["renderedPages"]), (565, 355, 210))
        self.assertEqual(manifest["totalOutputFiles"], 567)
        self.assertEqual(manifest["profile"], "preview")
        self.assertEqual(manifest["groups"], {"site": 21, "data": 2, "lyrics": 64, "stories": 64, "webp": 204,
                                              "pages": 210})

    def test_project_portfolio_policy(self):
        source = (REPO / "v2/index.html").read_text(encoding="utf-8")
        section = source.split('<section class="projects"', 1)[1].split('</section>', 1)[0]
        projects = ("MINDOT", "Next Point TR", "OpenFAOS", "TRALVID", "İŞTEÇ", "Dilek Kutum")
        positions = [section.index(f"<h3>{name}</h3>") for name in projects]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(section.count('<article class="project-card">'), 6)
        self.assertEqual(section.count('class="project-media" href='), 2)
        self.assertEqual(section.count('class="project-link" href='), 2)
        self.assertEqual(section.count('target="_blank"'), 4)
        self.assertEqual(section.count('rel="noopener noreferrer"'), 4)
        self.assertEqual(section.count('loading="lazy" decoding="async"'), 6)
        self.assertEqual(section.count('width="1200" height="675"'), 6)
        self.assertEqual(section.count('class="project-status"'), 6)
        self.assertEqual(section.count('alt="'), 6)
        self.assertEqual(section.count('<figure class="project-media">'), 4)
        self.assertEqual(section.count('konsept kapak'), 4)
        self.assertEqual(section.count("https://mind-ot.com/"), 2)
        self.assertEqual(section.count("https://nextpointtr.com/"), 2)
        for forbidden in ('href="#"', "isbuyutec.com", "localhost", "tralvid.com",
                          'project-no-link', 'project-placeholder', 'Doğrulanmış public bağlantı'):
            self.assertNotIn(forbidden, section)
        for asset in (
                "dilek-kutum-placeholder-1200.webp", "istec-placeholder-1200.webp",
                "mindot-homepage-1200.webp", "next-point-tr-homepage-1200.webp",
                "openfaos-placeholder-1200.webp", "tralvid-placeholder-1200.webp"):
            self.assertIn(f'images/projects/{asset}', section)

    def test_excluded_files_absent(self):
        self.build()
        names = set(self.tree())
        for rel in EXCLUDED:
            self.assertNotIn(rel, names)
        self.assertEqual([n for n in names if "/tools/" in n or n.startswith("tools/")], [])
        self.assertEqual([n for n in names if re.search(r"\.(py|md)$|(^|/)\.", n)], [])
        for v1 in ("index.html", "README.md", "perspective/index.html", "images/favicon.jpg.jpeg"):
            self.assertNotIn(v1, names)

    def test_output_bytes_identical_to_source(self):
        manifest = self.build()
        tree = self.tree()
        self.assertEqual(len(manifest["files"]), 355)
        for entry in manifest["files"]:
            source = (REPO / entry["path"]).read_bytes()
            self.assertEqual(tree[entry["path"]], source, entry["path"])
            self.assertEqual(bp.sha256(source), entry["sha256"])
        self.assertEqual(tree["v2/music/work/index.html"], (REPO / "v2/music/work/index.html").read_bytes())

    def test_rendered_pages_in_manifest(self):
        manifest = self.build()
        tree = self.tree()
        self.assertEqual({e["path"] for e in manifest["pages"]}, ALL_PAGES)
        for entry in manifest["pages"]:
            self.assertEqual(bp.sha256(tree[entry["path"]]), entry["sha256"])
            source = ("v2/index.html" if entry["path"] in {"v2/en/index.html", "v2/de/index.html"}
                      else "v2/music/index.html" if entry["path"] in {"v2/en/music/index.html", "v2/de/music/index.html"}
                      else "v2/music/work/index.html")
            self.assertEqual((entry["template"], entry["templateSha256"]),
                             (source, bp.sha256((REPO / source).read_bytes())))
            self.assertFalse((REPO / entry["path"]).exists(), "statik sayfa kaynakta olmamalı")
            if entry["path"] not in LOCALE_SHELLS:
                work_id = entry["path"][-11:-5]
                locale = entry["path"].split("/")[1]
                locale_prefix = locale + "/" if locale in ("en", "de") else ""
                self.assertIn(f'data-work-id="{work_id}"'.encode(), tree[entry["path"]])
                self.assertIn(f'href="https://unalbuyuksungur-v2.pages.dev/v2/{locale_prefix}music/work/{work_id}"'.encode(),
                              tree[entry["path"]])

    def test_catalog_and_page_references_resolve(self):
        self.build()
        names = set(self.tree())
        self.assertEqual(len(CATALOG["works"]), 68)
        self.assertEqual(len(CATALOG["recordings"]), 68)
        self.assertEqual(len(CATALOG["covers"]), 68)
        for work in CATALOG["works"]:
            for key in ("lyrics", "story"):
                self.assertIn(bp.MUSIC + work[key]["file"], names)
        for cover in CATALOG["covers"]:
            for image in cover["webImages"]:
                self.assertIn(bp.MUSIC + image["path"], names)
        for page in ("v2/index.html", "v2/music/index.html", "v2/music/work/index.html", *sorted(ALL_PAGES)):
            parser = bp.Links()
            parser.feed(self.tree()[page].decode("utf-8"))
            for ref in parser.refs:
                target = bp.resolve_ref(page, ref)
                if target is not None:
                    self.assertIn(target, names, f"{page}: {ref}")

    def test_generated_pages_config(self):
        self.build()
        tree = self.tree()
        self.assertIn(b"X-Robots-Tag: noindex", tree["_headers"])
        self.assertEqual(tree["_headers"], HEADERS_BEFORE)
        self.assertIn(b"/  /v2/  302", tree["_redirects"])
        self.assertEqual([n for n in tree if n.endswith(("robots.txt", "sitemap.xml"))], [])

    def test_deterministic_and_replaces_previous_output(self):
        first = self.build()
        (self.root / "_site" / "v2" / "stale.txt").write_text("eski", encoding="utf-8")
        second = self.build()
        self.assertEqual(first["packageDigest"], second["packageDigest"])
        self.assertNotIn("v2/stale.txt", self.tree())

    # --- Başarısızlık durumları ---

    def test_missing_source_stops_build(self):
        (self.root / "v2/music/images/c-0001-400.webp").unlink()
        self.assert_fails("[SRC-MISSING]")
        self.assertFalse((self.root / "_site").exists())

    def test_webp_hash_mismatch_stops_build(self):
        path = self.root / "v2/music/images/c-0002-800.webp"
        data = bytearray(path.read_bytes())
        data[-1] ^= 0xFF
        path.write_bytes(bytes(data))
        self.assert_fails("[HASH-EXPECTED]")

    def test_content_hash_mismatch_stops_build(self):
        path = self.root / "v2/music/content/lyrics/w-0003.txt"
        path.write_bytes(path.read_bytes() + b"\n")
        self.assert_fails("[HASH-EXPECTED]")

    def test_unexpected_files_rejected(self):
        for rel in ("v2/music/images/c-0099-400.webp", "v2/music/content/stories/x-0001.txt"):
            with self.subTest(rel=rel):
                extra = self.root / rel
                extra.write_bytes(b"x")
                self.assert_fails("[SRC-UNEXPECTED]")
                extra.unlink()
        retired = self.root / "v2/music/content/lyrics/r-0058.txt"
        retired.write_bytes(retired.read_bytes() + b" ")
        self.assert_fails("[SRC-UNEXPECTED]")

    def test_path_traversal_rejected(self):
        drive = "C" + ":/Windows/win.ini"  # parçalardan kurulur (test_public_source sürücü yolu kalıbı)
        for rel in ("v2/../index.html", "v2/music/../../.gitignore", "/etc/passwd", drive,
                    "v2\\music\\catalog.js", "index.html", "v2//music/catalog.js", "v2/./music/catalog.js"):
            with self.subTest(rel=rel), self.assertRaises(bp.BuildError):
                bp.checked_source(self.root.resolve(), rel)
        cases = [("works", 0, "lyrics", "content/lyrics/../../tools/validate_catalog.py"),
                 ("works", 1, "story", "../data/README.md"),
                 ("covers", 0, "webImages", "../tools/validate_catalog.py")]
        original = (self.root / bp.CATALOG).read_bytes()
        for section, index, key, bad in cases:
            with self.subTest(bad=bad):
                catalog = json.loads(original)
                if key == "webImages":
                    catalog[section][index][key][0]["path"] = bad
                else:
                    catalog[section][index][key]["file"] = bad
                (self.root / bp.CATALOG).write_text(json.dumps(catalog, ensure_ascii=False), encoding="utf-8")
                self.assert_fails("[CAT-")
        catalog = json.loads(original)
        catalog["$schema"] = "../README.md"
        (self.root / bp.CATALOG).write_text(json.dumps(catalog, ensure_ascii=False), encoding="utf-8")
        self.assert_fails("[CAT-SCHEMA]")

    def test_symlink_escape_rejected(self):
        # Dosya bağı: içerik aynı olsa bile depo dışını gösteren bağ kabul edilmez.
        target = self.root / "v2/music/images/c-0003-400.webp"
        secret = self.outside / "c-0003-400.webp"
        shutil.copyfile(target, secret)
        target.unlink()
        try:
            os.symlink(secret, target)
        except OSError as exc:
            self.skipTest(f"sembolik bağ oluşturulamadı: {exc}")
        self.assert_fails("[SRC-LINK]")
        target.unlink()
        shutil.copyfile(secret, target)
        # Klasör bağı: content/stories depo dışındaki bir kopyayı gösteriyor.
        stories = self.root / "v2/music/content/stories"
        shutil.copytree(stories, self.outside / "stories")
        shutil.rmtree(stories)
        os.symlink(self.outside / "stories", stories, target_is_directory=True)
        self.assert_fails("[SRC-LINK]")

    @unittest.skipUnless(os.name == "nt", "junction yalnızca Windows'ta")
    def test_junction_escape_rejected(self):
        images = self.root / "v2/music/images"
        shutil.copytree(images, self.outside / "images")
        shutil.rmtree(images)
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(images), str(self.outside / "images")],
                                capture_output=True)
        if result.returncode != 0:
            self.skipTest("junction oluşturulamadı")
        self.assert_fails("[SRC-LINK]")

    def test_unsafe_output_paths_rejected(self):
        for out in (".", "v2", "v2/music/_site", ".git", "../_site", str(self.outside / "_site"), "images"):
            with self.subTest(out=out):
                self.assert_fails("[OUT-PATH]", out=out)
        foreign = self.root / "notes"
        foreign.mkdir()
        (foreign / "keep.txt").write_text("kullanıcı dosyası", encoding="utf-8")
        self.assert_fails("[OUT-FOREIGN]", out="notes")
        self.assertEqual((foreign / "keep.txt").read_text(encoding="utf-8"), "kullanıcı dosyası")

    def test_failed_build_keeps_previous_output(self):
        good = self.build()
        before = self.tree()
        (self.root / "v2/music/content/stories/w-0004.txt").unlink()
        self.assert_fails("[SRC-MISSING]")
        self.assertEqual(self.tree(), before)
        self.assertEqual(bp.sha256("".join(f"{p}  {bp.sha256(before[p])}\n" for p in sorted(before)
                                           if p not in bp.GENERATED).encode("utf-8")), good["packageDigest"])

    def test_expect_count_mismatch_stops_build(self):
        self.assert_fails("[OUT-COUNT]", expect_count=343)
        self.assertFalse((self.root / "_site").exists())

    def test_render_errors_stop_build_and_keep_output(self):
        self.build()
        before = self.tree()
        original = (self.root / bp.CATALOG).read_bytes()
        catalog = json.loads(original)
        catalog["works"][1]["title"] = catalog["works"][0]["title"]
        (self.root / bp.CATALOG).write_text(json.dumps(catalog, ensure_ascii=False), encoding="utf-8")
        self.assert_fails("[SEO-DUP]")
        self.assertEqual(self.tree(), before)
        (self.root / bp.CATALOG).write_bytes(original)
        template = self.root / "v2/music/work/index.html"
        template.write_bytes(template.read_bytes().replace(b"<title>", b"<title>A</title><title>", 1))
        self.assert_fails("[SEO-TEMPLATE]")
        self.assertEqual(self.tree(), before)

    def test_cli_exit_codes(self):
        run = [sys.executable, "-I", str(SCRIPT), "--root", str(self.root), "--out", "_site"]
        ok = subprocess.run(run + ["--expect-count", "565"], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertIn("355/355", ok.stdout)
        self.assertIn("üretilen eser sayfası 210", ok.stdout)
        manifest = json.loads((self.root / "_site-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["totalOutputFiles"], 567)
        (self.root / "v2/music/catalog.css").unlink()
        failed = subprocess.run(run, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(failed.returncode, 1)
        self.assertIn("BUILD FAILED", failed.stderr)
        self.assertTrue((self.root / "_site/v2/music/catalog.css").is_file(), "önceki çıktı korunmalı")


if __name__ == "__main__":
    unittest.main(verbosity=2)
