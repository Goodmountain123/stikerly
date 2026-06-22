# 어셋 팩 구조

한 개의 `sticker_packs` 행이 하나의 판매·구매 단위입니다.

- `stickers.pack_id`: 팩에 포함된 스티커
- `backgrounds.pack_id`: 팩에 포함된 배경
- `backgrounds.pack_id`가 비어 있으면 관리자 페이지의 `미분류 배경`에 표시됩니다.

## 적용

Supabase SQL Editor에서 `schema.sql` 전체를 다시 실행합니다.

기존 발레 스튜디오 배경은 `ballet-poodle` 팩으로 자동 연결됩니다. 백조의 호수 배경이 자동 연결되지 않으면 관리자 페이지의 `미분류 배경`에서 선택한 뒤 `팩으로 이동`을 사용합니다.

클라이언트의 스티커 탭과 배경 탭 UI는 기존처럼 각각 분리되어 표시됩니다.
