# CliffsNotes Unblur

Gỡ blur / paywall overlay khi đọc tài liệu trên https://www.cliffsnotes.com/

## Cài đặt

1. `chrome://extensions` → bật **Developer mode**
2. **Load unpacked** → chọn thư mục này
3. Mở một trang document trên cliffsnotes.com và **reload**

Yêu cầu Chrome 111+ (dùng `world: "MAIN"` cho content script).

## Cách hoạt động

Extension chạy hai lớp độc lập, lớp nào hỏng thì lớp kia vẫn có tác dụng.

### `inject.js` — lớp network (MAIN world, `document_start`)

Patch `window.fetch` và `XMLHttpRequest.prototype.open`, chỉnh JSON trả về từ
`/api/v*/documents/*` trước khi trang đọc nó.

Bắt buộc phải ở **MAIN world**: content script mặc định chạy ở isolated world và
có bản `fetch` riêng, ghi đè ở đó không ảnh hưởng gì tới request của trang.

Không dùng `webRequest` — MV3 đã bỏ `webRequestBlocking`. Và
`declarativeNetRequest` **không** thay thế được ở đây: DNR chỉ block / redirect /
sửa header, không đọc hay sửa được response body. Nên toàn bộ việc này phải làm
trong realm của trang.

Payload được duyệt đệ quy và scrub mọi string leaf, thay vì bám cứng vào
`data.response.htmlPreviews` — API đổi shape thì vẫn chạy.

### `content.js` — lớp DOM (ISOLATED world, `document_start`)

Ba pass, rẻ trước đắt sau:

1. **Stylesheet tĩnh** với `!important` — ăn được cả blur đến từ external
   stylesheet mà không cần đụng node nào.
2. **Quét computed style** — `getComputedStyle` đã resolve xong nên bắt được blur
   từ mọi nguồn. Kết quả cache trong `WeakSet`, chỉ invalidate khi `style`/`class`
   của node đó đổi. Kèm một pass ghi đè trực tiếp trong CSSOM
   (`document.styleSheets`) cho các sheet same-origin / CORS.
3. **Ẩn paywall overlay** — chỉ ẩn element vừa được định vị (fixed/sticky/absolute),
   vừa phủ phần lớn viewport, **và** chứa keyword paywall. Cổng keyword là thứ giữ
   cho modal / dropdown / backdrop bình thường không bị đụng.

Chạy bằng `MutationObserver` (không phải `setInterval`). Mỗi pass gọi
`observer.takeRecords()` ở cuối để vứt đúng những record do chính nó tạo ra —
đó là toàn bộ cơ chế chống vòng lặp.

### `background.js` — service worker

Chỉ giữ setting on/off, badge ON/OFF, và inject lại content script vào các tab
đang mở sẵn lúc cài đặt. Không đụng gì tới network.

## Popup

Bật/tắt, xem số element / CSS rule / overlay đã xử lý, quét lại, reload trang.

Tắt sẽ revert các inline style extension đã ghi. Riêng CSS rule đã ghi đè trong
CSSOM thì không revert được — reload trang là xong.

## Giới hạn

- Nội dung server không bao giờ gửi về thì không có cách nào hiện ra được.
- Stylesheet cross-origin không kèm CORS header thì không đọc được `cssRules`;
  lúc đó chỉ còn lớp override tĩnh và pass computed-style lo.
- Lớp network chỉ ăn từ đầu vòng đời trang — vào giữa chừng thì phải reload.

## Files

| File | Vai trò |
|---|---|
| `manifest.json` | MV3, khai báo hai content script ở hai world |
| `inject.js` | Patch fetch/XHR trong MAIN world |
| `content.js` | Gỡ blur & overlay trong DOM |
| `background.js` | Setting, badge, inject lại tab đang mở |
| `popup.html/.css/.js` | UI bật tắt + thống kê |
| `icons/` | 16/32/48/128 px |
