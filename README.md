# Muhabbet

Muhabbet, arkadaş gruplarının saniyeler içinde ortak bir sohbet odası açıp konuşabildiği bir web sitesidir. Kayıt gerektirmez: bir takma ad ve renk seçersin, bir oda kurarsın, davet bağlantısını arkadaşlarına gönderirsin.

## Özellikler

- **Oda kurma** – isim ve simge seçerek yeni bir oda; her odanın kısa bir davet kodu (`/oda/<kod>`) vardır.
- **Koda/bağlantıya katılma** – kodu veya bağlantıyı yapıştırarak odaya gir.
- **Canlı sohbet** – mesajlar yaklaşık 2 saniyede bir yenilenir; ardışık mesajlar gruplanır, gün ayraçları, bağlantılar ve büyük emoji desteği.
- **Çevrimiçi listesi ve "yazıyor…" göstergesi**.
- **Profil** – takma ad ve renk tarayıcıda saklanır, oda içinden düzenlenebilir.
- **Son odalar** – ziyaret edilen odalar ana sayfada listelenir.

## Teknolojiler

- TanStack Start (React 19, TanStack Router) + Vite
- Tailwind CSS 4, shadcn/ui bileşenleri, lucide-react
- Netlify Database (yönetilen Postgres) + Drizzle ORM
- Netlify üzerinde dağıtım

## Yerel çalıştırma

```bash
pnpm install
netlify dev   # Netlify Database emülasyonu dahil
```

Veritabanı şeması `db/schema.ts` içindedir. Şemayı değiştirdikten sonra:

```bash
npx drizzle-kit generate --name <aciklayici_isim>
```

Migration dosyaları `netlify/database/migrations/` klasörüne yazılır ve dağıtım sırasında Netlify tarafından otomatik uygulanır.

## İleride eklenebilecekler

- WebSocket/SSE tabanlı anlık iletim (şu an kısa aralıklı yoklama kullanılıyor)
- Mesajlara tepki (emoji reaksiyon), yanıtlama ve resim paylaşımı
- İsteğe bağlı hesap sistemi ve özel/şifreli odalar
