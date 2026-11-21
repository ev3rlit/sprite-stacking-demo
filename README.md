# Sprite Stacking Test

4면 PNG에서 스택과 메시를 브라우저에서 생성하는 차량·개미 메카 데모입니다. 차종별 조작과 어빌리티, 캐니스터 충돌, 레이어·텍스처 해상도 설정, Marching Cubes 및 다중 뷰 텍스처링 비교를 포함합니다.

## 실행

```sh
npm run build
npm test
```

Node.js 20 이상이 필요합니다. `dist/index.html`을 브라우저에서 열면 실행됩니다. 이 파일에는 HTML, CSS, JavaScript, 변환 Worker, 데모가 사용하는 PNG가 들어 있어 오프라인에서도 열 수 있습니다.

## 구조

- `src/` 화면, 런타임, 변환 Worker, 에셋 카탈로그
- `assets/` 4면 PNG, 슬라이스, 콘셉트 이미지
- `examples/` 택시, 점검 로봇, 개미 메카, 로버의 개별 데모
- `dist/index.html` 배포와 오프라인 실행에 사용하는 단일 HTML

현재 통합 데모의 에셋 구성은 [에셋 노트](ASSET-NOTES.md)에 정리했습니다. 원본이나 런타임을 바꾸면 단일 HTML도 다시 빌드합니다.

## GPT Sites에 배포

정적 사이트 디렉터리는 `dist`입니다. 배포에 필요한 애플리케이션 파일은 `dist/index.html` 하나입니다. 새 버전을 배포하려면 원본을 변경한 뒤 `npm run build && npm test`로 이 파일을 다시 만들고, 갱신된 파일을 Sites의 정적 빌드로 올립니다.
