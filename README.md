# Stickerly — 스티커 에디터 (정적 웹앱)

Flutter 기획안을 그대로 웹으로 옮긴 **MVP 스티커 에디터**입니다. 빌드 단계가
없는 순수 정적 사이트라서 그대로 Git에 올리고 Cloudflare Pages에 배포할 수 있어요.

- 캔버스 엔진: [Konva.js] (CDN)
- 저장: 브라우저 IndexedDB (로컬, 서버 없음)
- 내보내기: 클라이언트에서 원본 캔버스 크기로 PNG 생성
- 빌드 도구 없음 — `index.html` + ES 모듈 + 정적 PNG

## 기능 (MVP)

- 프로젝트 만들기 / 열기 / 이름 변경 / 삭제 (스마트폰 9:16, 태블릿 3:4)
- 스티커 트레이: 팩 캐러셀 → 선택한 팩의 스티커 캐러셀
- 트레이에서 캔버스로 **드래그&드롭**으로 스티커 추가
- 한 번 탭하면 선택(사각형 프레임 + 회전 핸들 1개)
- 이동(드래그) · 크기(두 손가락 핀치) · 회전(핸들)
- 캔버스 두 손가락 패닝 / 핀치 줌 (0.5–2.0배, 줌은 저장되지 않음)
- 더블 탭하면 아이콘 메뉴: 좌우반전 · 상하반전 · 앞으로 · 뒤로 · 효과 · 삭제
- 효과(2단계): 바닥 그림자(MVP 기본) · 외곽선 · 블러 · 색상 보정 + 0~1 슬라이더
- 실행 취소 / 다시 실행, 저장, PNG 내보내기

## 로컬에서 실행

ES 모듈과 `fetch`를 쓰기 때문에 `file://`로 직접 열면 안 되고, 간단한 정적 서버로
띄워야 합니다.

```bash
cd sticker-editor
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000
```

(또는 `npx serve` 등 아무 정적 서버나 사용 가능)

## Cloudflare Pages 배포

1. 이 폴더를 Git 저장소에 푸시합니다.
2. Cloudflare 대시보드 → **Workers & Pages → Create → Pages → Connect to Git**.
3. 저장소를 선택하고 빌드 설정을 다음과 같이 둡니다.
   - **Framework preset:** None
   - **Build command:** (비워둠)
   - **Build output directory:** `/` (저장소 루트가 이 폴더면 그대로, 하위 폴더면
     `sticker-editor`)
4. Save and Deploy. 끝입니다 — 빌드 과정이 없습니다.

> 스티커 PNG는 아주 작아 파일 수/용량 제한(무료 플랜 사이트당 20,000개, 파일당
> 25 MiB)에 전혀 문제되지 않습니다.

## 스티커 교체 / 팩 추가

샘플 스티커는 자리표시용 그림입니다. 실제 아트로 바꾸려면 PNG(투명 배경)만
같은 경로에 덮어쓰면 됩니다.

새 팩을 추가하려면:

```
assets/sticker_packs/
  index.json                 ← 팩 폴더 id 목록
  <팩id>/
    pack.json                ← { id, name, thumbnail, stickers:[파일명...] }
    sticker1.png
    sticker2.png
```

1. `assets/sticker_packs/<팩id>/` 폴더를 만들고 PNG를 넣습니다.
2. 그 안에 `pack.json`을 작성합니다.
   ```json
   {
     "id": "myfriends",
     "name": "내친구팩",
     "thumbnail": "hello.png",
     "stickers": ["hello.png", "bye.png"]
   }
   ```
3. `assets/sticker_packs/index.json` 배열에 `"myfriends"`를 추가합니다.

앱은 시작할 때 `index.json`을 읽고 각 `pack.json`을 불러와 트레이를 구성합니다.

## 데이터 구조 (확장 고려)

프로젝트는 IndexedDB의 `stickerly` DB → `projects` 스토어에 저장됩니다.

```jsonc
Project {
  id, title, canvasWidth, canvasHeight,
  createdAt, updatedAt,
  stickerItems: [ StickerItem ]
}
StickerItem {
  id, packId, assetId,
  x, y, scale, rotation, flipX, flipY, zIndex,
  effects: {
    floorShadow: { enabled, intensity, blur, x, y, scale },
    blur:        { enabled, intensity },
    brightness:  { enabled, intensity },
    outglow:     { enabled, intensity, color }
  }
}
```

로그인 / 서버 / 클라우드 / 커뮤니티 / 결제는 MVP에 포함하지 않았지만, 위 구조는
나중에 사용자·유료 팩·동기화를 붙일 수 있도록 설계돼 있습니다.

## 폴더 구조

```
sticker-editor/
  index.html
  styles.css
  js/
    main.js        앱 라우팅 + 프로젝트 목록
    storage.js     IndexedDB
    packs.js       팩 로딩 / 이미지 캐시
    model.js       데이터 모델 + 캔버스 규격
    sticker.js     스티커 노드(이미지+그림자) 빌더
    effects.js     그림자 / 블러 / 밝기 / 아웃글로우
    editor.js      에디터(스테이지·제스처·메뉴·되돌리기)
    export.js      원본 크기 PNG 내보내기
  assets/sticker_packs/...   번들 스티커팩
```

[Konva.js]: https://konvajs.org/
