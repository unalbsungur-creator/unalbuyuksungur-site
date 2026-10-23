#!/usr/bin/env python3
"""V2 web yayın paketi oluşturucu (allowlist; Cloudflare Pages ve yerel önizleme için).

Görev 30–31: depo kökü olduğu gibi yayımlanmaz. Yalnızca sitenin çalışması için gereken V2 dosyaları,
v2/ öneki korunarak çıktı klasörüne bayt bayt kopyalanır. Allowlist sabit site dosyalarından ve
catalog.json'daki yollardan türetilir; WebP'ler catalog.json'daki, söz/hikâye dosyaları
verify_content_integrity.py'deki onaylı SHA-256 değeriyle doğrulanır; geliştirme araçları (tools/), data/README.md, emekli söz dosyaları,
Git yapılandırması ve V1 dosyaları pakete hiç girmez.

Görev 73: her eser için statik sayfa (v2/music/work/w-0001.html …) render_pages.py ile eser şablonundan
üretilir. Bu sayfalar kaynakta yoktur, yalnızca pakette bulunur; manifestte "pages" altında şablon SHA-256'sıyla
kaydedilir. Kopyalanan dosyalar (şablonun kendisi dahil) kaynakla bayt bayt aynı kalır.

Sıra: kaynak ve katalog denetimi -> geçici staging klasöründe kopyalama ve sayfa üretimi -> SHA-256 ve bağlantı denetimi ->
çıktı kümesinin allowlist'e tam eşitliği -> staging'in çıktı klasörüyle güvenli yer değiştirmesi. Herhangi
bir denetim başarısız olursa staging silinir, mevcut çıktı klasörüne dokunulmaz ve çıkış kodu 1 olur.
Kaynak dosyalar yalnızca okunur.

Kullanım:
    python v2/music/tools/build_publication.py --out _site
    python v2/music/tools/build_publication.py --out _site --expect-count 411

Cloudflare Pages (ayrı V2 projesi): build command
    python3 v2/music/tools/build_publication.py --out _site
build output directory: _site

Çıkış kodu: paket üretildiyse 0, aksi hâlde 1.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

sys.dont_write_bytecode = True  # v2/ altında __pycache__ oluşmasın (herkese açık klasör)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_catalog import RETIRED_CONTENT  # noqa: E402  (kurallar tek yerde)
from verify_content_integrity import CONTENT_SHA256  # noqa: E402  (onaylı söz/hikâye SHA-256 tablosu)
import render_pages  # noqa: E402  (statik eser sayfaları)

DEFAULT_ROOT = Path(__file__).resolve().parents[3]

# Sabit site dosyaları (depo köküne göre). Başka HTML/CSS/JS/görsel eklenirse burası bilinçli güncellenmeli.
SITE_FILES = (
    "v2/index.html",
    "v2/external-links.js",
    "v2/images/unal-digital-world-hero.png",
    "v2/music/index.html",
    "v2/music/catalog.css",
    "v2/music/catalog.js",
    "v2/music/work/index.html",
    "v2/music/work/work.css",
    "v2/music/work/work.js",
)
MUSIC = "v2/music/"
CATALOG = MUSIC + "data/catalog.json"
CONTENT_PATH = re.compile(r"^content/(lyrics|stories)/[wr]-\d{4}\.txt$")  # work.js ile aynı kalıp
IMAGE_PATH = re.compile(r"^images/c-\d{4}-(400|800|1200)\.webp$")
SCHEMA_PATH = re.compile(r"^\./[a-z]+\.json$")
# JS içindeki yerel yol sabitleri: dosya -> {sabit: (beklenen değer, beklenen hedef dosya)}
JS_CONSTANTS = {
    MUSIC + "catalog.js": {"CATALOG_URL": ("data/catalog.json", CATALOG),
                           "DETAIL_URL": ("work/", MUSIC + "work/index.html")},
    MUSIC + "work/work.js": {"CATALOG_URL": ("../data/catalog.json", CATALOG),
                             "MUSIC_ROOT": ("../", MUSIC + "index.html")},
}

# Pages yapılandırma dosyaları: statik dosya olarak sunulmaz. İlk satır, bu aracın ürettiği bir çıktı
# klasörünü tanımak için işarettir (başka bir klasör asla silinmez).
MARKER = "# build_publication.py tarafından üretildi; elle düzenlemeyin."
PROFILE = "preview"  # yalnızca preview; production profili bu sürümde yok (render_pages.PROFILES)
GENERATED = {
    "_headers": MARKER + "\n/*\n  X-Robots-Tag: noindex\n  X-Content-Type-Options: nosniff\n"
                "  Referrer-Policy: strict-origin-when-cross-origin\n",
    "_redirects": MARKER + "\n/  /v2/  302\n",
}

# Son savunma: çıktıda bulunmaması gereken her şey (allowlist'e yanlışlıkla girse bile).
FORBIDDEN_OUTPUT = re.compile(
    r"(^|/)(\.[^/]*|tools|optimization-test|functions|__pycache__|node_modules)(/|$)"
    r"|\.(py|pyc|md|docx?|bak|tmp|log)$|(^|/)README|(^|/)r-\d{4}\.txt$|-eski\.|(^|/)_worker\.js$|_routes\.json$",
    re.IGNORECASE)


class BuildError(Exception):
    pass


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def checked_source(root, rel):
    """Göreli yolu doğrular, depo içinde kalan gerçek bir dosyaya çözer; baytlarını döndürür."""
    if not rel or "\\" in rel or rel.startswith("/") or re.match(r"^[A-Za-z]:", rel):
        raise BuildError(f"[SRC-PATH] geçersiz yol: {rel!r}")
    parts = rel.split("/")  # ham bileşenler: PurePosixPath "//" ve "." bileşenlerini sessizce atar
    if any(p in ("", ".", "..") for p in parts) or parts[0] != "v2":
        raise BuildError(f"[SRC-PATH] v2/ dışına ya da üst klasöre çıkan yol: {rel!r}")
    current = root
    for part in parts:  # her bileşen: sembolik bağ ya da junction kabul edilmez
        current = current / part
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            raise BuildError(f"[SRC-LINK] sembolik bağ/junction: {rel}")
    try:
        resolved = current.resolve(strict=True)
    except FileNotFoundError:
        raise BuildError(f"[SRC-MISSING] kaynak dosya yok: {rel}") from None
    if not resolved.is_relative_to(root / "v2"):
        raise BuildError(f"[SRC-ESCAPE] depo dışına çözülüyor: {rel}")
    if not resolved.is_file():
        raise BuildError(f"[SRC-TYPE] normal dosya değil: {rel}")
    return resolved.read_bytes()


def load_catalog(root):
    try:
        return json.loads(checked_source(root, CATALOG).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BuildError(f"[CAT-JSON] catalog.json okunamadı: {exc}") from None


def plan(root, catalog):
    """Allowlist: {depo göreli yol: (beklenen SHA-256, bayt) ya da None}. Katalog yolları kalıplarla sınırlıdır."""
    files = {rel: None for rel in SITE_FILES}
    files[CATALOG] = None
    schema = catalog.get("$schema")
    if not isinstance(schema, str) or not SCHEMA_PATH.match(schema):
        raise BuildError(f"[CAT-SCHEMA] beklenmeyen $schema: {schema!r}")
    files[MUSIC + "data/" + schema[2:]] = None
    for work in catalog.get("works", []):
        for key in ("lyrics", "story"):
            asset = work.get(key) or {}
            if asset.get("status") != "published":
                continue
            path = asset.get("file")
            if not isinstance(path, str) or not CONTENT_PATH.match(path):
                raise BuildError(f"[CAT-CONTENT] {work.get('id')} {key}: geçersiz yol {path!r}")
            if path not in CONTENT_SHA256:
                raise BuildError(f"[HASH-CONTENT] onaylı SHA-256 tablosunda yok: {path}")
            files[MUSIC + path] = (CONTENT_SHA256[path], None)
    for cover in catalog.get("covers", []):
        for image in cover.get("webImages", []):
            path = image.get("path")
            if not isinstance(path, str) or not IMAGE_PATH.match(path):
                raise BuildError(f"[CAT-IMAGE] {cover.get('id')}: geçersiz yol {path!r}")
            if MUSIC + path in files:
                raise BuildError(f"[CAT-IMAGE] aynı görsel iki kez: {path}")
            files[MUSIC + path] = (image.get("sha256"), image.get("bytes"))
    # Katalogda olmayan içerik/görsel dosyası: yalnızca onaylı emekli dosyalar (değişmemişse) atlanır.
    for folder, allowed in (("content/lyrics", RETIRED_CONTENT), ("content/stories", {}), ("images", {})):
        directory = root / MUSIC / folder
        if not directory.is_dir():
            raise BuildError(f"[SRC-MISSING] klasör yok: {MUSIC}{folder}")
        for entry in sorted(directory.iterdir()):
            rel = f"{folder}/{entry.name}"
            if MUSIC + rel in files:
                continue
            if rel in allowed and sha256(checked_source(root, MUSIC + rel)) == allowed[rel]:
                continue
            raise BuildError(f"[SRC-UNEXPECTED] katalogda olmayan dosya: {MUSIC}{rel}")
    return files


def render(root, catalog, files):
    """Statik eser sayfaları: {paket yolu: bayt}. İki kez üretilip karşılaştırılır (belirlenimcilik)."""
    template = checked_source(root, render_pages.TEMPLATE)
    try:
        pages = render_pages.render_work_pages(catalog, template, PROFILE)
        again = render_pages.render_work_pages(catalog, template, PROFILE)
    except render_pages.RenderError as exc:
        raise BuildError(str(exc)) from None
    if pages != again:
        raise BuildError("[SEO-DETERMINISM] aynı girdiyle iki üretim farklı")
    for rel in pages:
        if rel in files or rel in GENERATED or FORBIDDEN_OUTPUT.search(rel):
            raise BuildError(f"[SEO-PATH] üretilen sayfa mevcut ya da yasak bir yolla çakışıyor: {rel}")
    return pages, sha256(template)


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs = []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in ("href", "src") and value is not None:
                self.refs.append(value)


def resolve_ref(base, ref):
    """Göreli bağlantıyı depo göreli dosya yoluna çevirir; dış/sayfa içi bağlantılar için None."""
    parts = urlsplit(ref)
    if parts.scheme or parts.netloc or not parts.path:
        return None
    if parts.path.startswith("/"):
        raise BuildError(f"[REF-ABSOLUTE] kök göreli bağlantı desteklenmiyor: {ref}")
    target = os.path.normpath(os.path.join(os.path.dirname(base), parts.path)).replace("\\", "/")
    if parts.path.endswith("/") or parts.path in (".", ".."):
        target = target.rstrip("/") + "/index.html"
    return target


def check_references(files, read):
    """HTML src/href, CSS url(), JS yol sabitleri ve katalog yolları allowlist'teki dosyalara çözülmeli."""
    count = 0
    for rel in sorted(files):
        if rel.endswith(".html"):
            parser = Links()
            parser.feed(read(rel).decode("utf-8"))
            refs = parser.refs
        elif rel.endswith(".css"):
            refs = [m.strip("'\"") for m in re.findall(r"url\(\s*([^)]+?)\s*\)", read(rel).decode("utf-8"))]
            refs = [r for r in refs if not r.startswith("data:")]
        else:
            refs = []
        for ref in refs:
            target = resolve_ref(rel, ref)
            if target is not None:
                count += 1
                if target not in files:
                    raise BuildError(f"[REF-MISSING] {rel}: {ref} -> {target} pakette yok")
    for rel, constants in JS_CONSTANTS.items():
        source = read(rel).decode("utf-8")
        for name, (value, target) in constants.items():
            match = re.search(r"var " + name + r' = "([^"]*)";', source)
            if not match or match.group(1) != value or resolve_ref(rel, value) != target or target not in files:
                raise BuildError(f"[REF-JS] {rel}: {name} beklenen {value!r} -> {target} değil")
            count += 1
    return count


def safe_out(root, out):
    if out.is_absolute() or ".." in out.parts or not out.parts:
        raise BuildError(f"[OUT-PATH] --out depo kökü altında göreli bir klasör olmalı: {out}")
    target = root / out
    for parent in [target, *target.parents]:
        if parent == root:
            break
        if parent.is_symlink() or (hasattr(parent, "is_junction") and parent.is_junction()):
            raise BuildError(f"[OUT-PATH] sembolik bağ/junction içeren çıktı yolu: {out}")
    if out.parts[0] in ("v2", ".git", "images", "perspective") or out.parts[0].startswith("."):
        raise BuildError(f"[OUT-PATH] kaynak klasörü çıktı olarak kullanılamaz: {out}")
    if target.exists():
        marker = target / "_headers"
        if not target.is_dir() or not marker.is_file() or \
                marker.read_text(encoding="utf-8").splitlines()[:1] != [MARKER]:
            raise BuildError(f"[OUT-FOREIGN] {out} bu aracın ürettiği bir çıktı değil; silinmedi")
    return target


def git_commit(root):
    if os.environ.get("CF_PAGES_COMMIT_SHA"):
        return os.environ["CF_PAGES_COMMIT_SHA"]
    try:
        return subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True,
                              text=True, check=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def build(root, out, expect_count=None, manifest_path=None, log=print):
    root = root.resolve()
    target = safe_out(root, out)
    catalog = load_catalog(root)
    files = plan(root, catalog)
    pages, template_digest = render(root, catalog, files)

    staging = target.with_name(f"{target.name}.staging-{os.getpid()}")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    try:
        entries = []
        for rel in sorted(files):
            data = checked_source(root, rel)
            digest = sha256(data)
            expected = files[rel]
            if expected and (expected[0] != digest or expected[1] not in (None, len(data))):
                raise BuildError(f"[HASH-EXPECTED] {rel}: onaylı SHA-256/bayt değeriyle uyuşmuyor")
            if FORBIDDEN_OUTPUT.search(rel):
                raise BuildError(f"[OUT-FORBIDDEN] yasak dosya allowlist'te: {rel}")
            dest = staging / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            if sha256(dest.read_bytes()) != digest:
                raise BuildError(f"[HASH-COPY] kopya kaynakla aynı değil: {rel}")
            entries.append({"path": rel, "bytes": len(data), "sha256": digest})
        page_entries = []
        for rel in sorted(pages):
            dest = staging / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(pages[rel])
            if dest.read_bytes() != pages[rel]:
                raise BuildError(f"[HASH-COPY] üretilen sayfa yazılamadı: {rel}")
            page_entries.append({"path": rel, "bytes": len(pages[rel]), "sha256": sha256(pages[rel]),
                                 "template": render_pages.TEMPLATE, "templateSha256": template_digest})
        for name, text in GENERATED.items():
            (staging / name).write_bytes(text.encode("utf-8"))

        def read_staged(rel):
            return (staging / rel).read_bytes()
        references = check_references(set(files) | set(pages), read_staged)

        produced = sorted(p.relative_to(staging).as_posix() for p in staging.rglob("*") if not p.is_dir())
        expected_set = sorted([*files, *pages, *GENERATED])
        if produced != expected_set:
            extra = sorted(set(produced) - set(expected_set))
            missing = sorted(set(expected_set) - set(produced))
            raise BuildError(f"[OUT-SET] çıktı allowlist'e eşit değil; fazla {extra[:5]}, eksik {missing[:5]}")
        bad = [p for p in produced if p not in GENERATED and FORBIDDEN_OUTPUT.search(p)]
        if bad or any(p.is_symlink() for p in staging.rglob("*")):
            raise BuildError(f"[OUT-FORBIDDEN] çıktıda yasak dosya ya da bağ: {bad[:5]}")
        web = sorted(entries + page_entries, key=lambda e: e["path"])
        if expect_count is not None and len(web) != expect_count:
            raise BuildError(f"[OUT-COUNT] {len(web)} web dosyası; beklenen {expect_count}")

        digest = sha256("".join(f"{e['path']}  {e['sha256']}\n" for e in web).encode("utf-8"))
        groups = {
            "site": sum(rel in SITE_FILES for rel in files),
            "data": sum(rel.startswith(MUSIC + "data/") for rel in files),
            "lyrics": sum(rel.startswith(MUSIC + "content/lyrics/") for rel in files),
            "stories": sum(rel.startswith(MUSIC + "content/stories/") for rel in files),
            "webp": sum(rel.startswith(MUSIC + "images/") for rel in files),
            "pages": len(pages),
        }
        manifest = {
            "tool": "v2/music/tools/build_publication.py",
            "commit": git_commit(root),
            "output": out.as_posix(),
            "profile": PROFILE,
            "webFiles": len(web),
            "copiedFiles": len(entries),
            "renderedPages": len(page_entries),
            "generatedFiles": sorted(GENERATED),
            "totalOutputFiles": len(produced),
            "webBytes": sum(e["bytes"] for e in web),
            "groups": groups,
            "checkedReferences": references,
            "packageDigest": digest,
            "files": entries,
            "pages": page_entries,
        }

        # Güvenli yer değiştirme: eski çıktı önce kenara alınır, yeni paket yerine taşınır, sonra eski silinir.
        previous = target.with_name(f"{target.name}.previous-{os.getpid()}")
        if target.exists():
            target.rename(previous)
        try:
            staging.rename(target)
        except OSError:
            if previous.exists():
                previous.rename(target)
            raise
        if previous.exists():
            shutil.rmtree(previous)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)

    if manifest_path is not None:
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    log(f"V2 yayın paketi: {out.as_posix()}/")
    log(f"  web dosyası {len(web)}: kopyalanan {len(entries)} (site {groups['site']}, veri {groups['data']}, "
        f"söz {groups['lyrics']}, hikâye {groups['stories']}, WebP {groups['webp']}) + üretilen eser sayfası "
        f"{len(page_entries)} ({PROFILE}) + Pages yapılandırması {len(GENERATED)} = {len(produced)} dosya, "
        f"{manifest['webBytes']} bayt")
    log(f"  denetlenen bağlantı {references}; kaynak-çıktı SHA-256 eşleşmesi {len(entries)}/{len(entries)}")
    log(f"  commit {manifest['commit']}")
    log(f"  paket özeti (SHA-256) {digest}")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out", type=Path, required=True, help="depo köküne göre çıktı klasörü (ör. _site)")
    parser.add_argument("--expect-count", type=int, help="beklenen web dosyası sayısı (farklıysa build durur)")
    parser.add_argument("--manifest", type=Path, help="manifest JSON yolu (varsayılan: depo kökünde <out>-manifest.json)")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help=argparse.SUPPRESS)  # testler için
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    root = args.root.resolve()
    manifest = args.manifest or root / f"{args.out.name}-manifest.json"
    try:
        build(root, args.out, args.expect_count, manifest)
    except (BuildError, OSError) as exc:
        print(f"BUILD FAILED: {exc}", file=sys.stderr)
        print("Yayın paketi üretilmedi; mevcut çıktı klasörü değiştirilmedi.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
