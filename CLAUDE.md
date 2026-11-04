# Proje kuralları (unalbuyuksungur-site)

## Öncelik
1. V2'yi `unalbuyuksungur.com` kökünde canlıya almak.
2. Ardından Müzik Stüdyosu'nu sade biçimde (Shopier + form + e-posta) satışa açmak.

## Kapsam
- `studio_order_core/` **dondurulmuştur.** Sahibi açıkça istemedikçe değiştirilmez. Yeni güvenlik/sertleştirme fazı, yeni denetim turu veya yeni "üretim engeli" maddesi açılmaz.
- Her görev yalnızca komutta istenen kapsamı uygular. Kapsam dışı iyileştirmeler önerilebilir ama uygulanmaz.
- Push, `main` dalına işlem ve Cloudflare ayarı yalnızca komutta açıkça istenirse yapılır.

## Yayın düzeni
- **Canlı site:** `unalbuyuksungur.com` ← Cloudflare production dalı `release/v2-live`.
- **Önizleme:** `develop/v2-digital-world` ← `develop-v2-digital-world.unalbuyuksungur-v2.pages.dev`.
- Tüm geliştirmeler `develop/v2-digital-world` dalında yapılır ve önce önizlemeye push edilir.
- `release/v2-live` yalnızca sahip onayından sonra, komutta açıkça istendiğinde `git merge --ff-only develop/v2-digital-world` ile güncellenir.
- Cloudflare build komutu: `python3 v2/music/tools/build_publication.py --profile production --out _site`

## Raporlama ve test
- Raporlar Türkçe, komutta verilen RAPOR formatında yazılır.
- Testler gerçek riski kapsayacak kadar olmalı; aşırı büyük test dosyaları oluşturulmaz.
