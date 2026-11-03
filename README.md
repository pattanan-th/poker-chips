# Poker Chips

เว็บนับชิปโป๊กเกอร์สำหรับเล่นกับไพ่จริง ทุกคนใช้มือถือของตัวเองกด Fold / Check / Call / Raise ได้ ไม่ต้องใช้ server และไม่ต้องสมัครบัญชี
มือถือของเจ้ามือทำหน้าที่เป็นเครื่องหลัก (WebRTC ผ่าน PeerJS) คนอื่นสแกน QR เข้าห้อง

- Texas Hold'em No-Limit: blinds/ante, ปุ่ม Dealer หมุนเอง, min-raise, side pot, split pot, คืน uncalled bet
- Cash game (rebuy + สรุปเงิน) หรือ Tournament (blind ขึ้นตามเวลา, จัดอันดับ)
- เจ้ามือ: Undo, กดแทนผู้เล่น, แก้ชิป, จัดที่นั่ง, หยุดเวลา

ทดสอบ engine: `node tests/engine.test.js`
