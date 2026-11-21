# Sprite Stacking Test

4면 PNG에서 스택과 메시를 브라우저에서 생성하는 차량·개미 메카 데모입니다. 차종별 조작과 어빌리티, 캐니스터 충돌, 레이어·텍스처 해상도 설정, Marching Cubes 및 다중 뷰 텍스처링 비교를 포함합니다.

## 모델 턴테이블

<table>
  <thead>
    <tr>
      <th scope="col">4륜 물류 로버</th>
      <th scope="col">점검 로봇</th>
      <th scope="col">개미 메카</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td width="33%" align="center"><img src="docs/media/rover-turntable.gif" width="352" alt="4륜 물류 로버의 360도 회전"></td>
      <td width="33%" align="center"><img src="docs/media/inspection-turntable.gif" width="352" alt="점검 로봇의 360도 회전"></td>
      <td width="33%" align="center"><img src="docs/media/ant-turntable.gif" width="352" alt="개미 메카의 360도 회전"></td>
    </tr>
  </tbody>
</table>

## 런타임 워크플로우

![로버의 4면 원본, 실루엣을 교차해 생성한 슬라이스, 런타임 렌더링과 층줄 보정 전후 비교](docs/media/workflow.png)

1. **4면 이미지 입력** — 브라우저가 [로버 차체 원본 PNG](assets/rover/fillet-rover-body-4-view.png)를 윗면, 왼쪽 옆면, 앞면, 뒷면으로 나눕니다. 바퀴는 별도 4면 이미지에서 복원하고 차축을 기준으로 조향하고 회전시킵니다.
2. **런타임 복원과 캐싱** — Web Worker가 네 실루엣의 교집합을 계산해 복셀과 높이별 슬라이스를 만듭니다. 레이어 수와 텍스처 배율에 따라 격자가 달라지며, 동일한 설정은 메모리나 IndexedDB에 캐싱된 결과를 재사용합니다.
3. **스택 또는 메시 렌더링** — 수평 슬라이스를 쌓아 그리거나, Marching Cubes로 복셀 경계를 이어 삼각형 표면을 만듭니다. 다중 뷰 텍스처링은 표면 방향과 원본 뷰에서의 가시성을 반영해 색을 고르고, 비슷한 색끼리 혼합합니다.

### 층줄 보정

수평 스택은 특정 각도에서 층 경계가 드러납니다. 위 사례에서는 앞면의 밝은 색이 인접한 층 가장자리에 반복되어 점선처럼 보입니다. Marching Cubes는 층 사이를 연속된 표면으로 잇고, 다중 뷰 텍스처링은 그 표면에 맞는 원본 색을 다시 투영합니다. 두 기능은 공용 렌더링 패널에서 각각 전환할 수 있습니다.

위 전후 화면은 같은 각도, 120레이어, 텍스처 2×, Spacing 1.00에서 실제 데모를 캡처한 결과입니다. 확대 영역의 차이는 두 렌더링 기능을 함께 켰을 때의 결과입니다.

## 실행

```sh
npm run build
npm test
```

Node.js 20 이상이 필요합니다. `dist/index.html`을 브라우저에서 열면 실행됩니다. 이 파일에는 HTML, CSS, JavaScript, 변환 Worker, 데모가 사용하는 PNG가 들어 있어 오프라인에서도 열 수 있습니다.

공용 렌더링에서 서브픽셀 AA와 Specular AA를 각각 켜고 끌 수 있습니다. 서브픽셀 AA는 모델과 프롭의 윤곽을 네 지점에서 샘플링하고, Specular AA는 재질 조명을 켰을 때 노멀 변화가 큰 반사를 완화합니다.

화면의 성능 패널은 FPS, 프레임 간격, 렌더 CPU 시간을 400ms 단위로 표시합니다. AA 또는 슈퍼샘플링을 전환하면 새 설정으로 측정을 다시 시작합니다. 렌더 CPU 시간은 브라우저에서 렌더링 코드를 실행하는 데 걸린 시간입니다.

## 구조

- `src/` 화면, 런타임, 변환 Worker, 에셋 카탈로그
- `assets/` 4면 PNG, 슬라이스, 콘셉트 이미지
- `examples/` 택시, 점검 로봇, 개미 메카, 로버의 개별 데모
- `dist/index.html` 배포와 오프라인 실행에 사용하는 단일 HTML

현재 통합 데모의 에셋 구성은 [에셋 노트](ASSET-NOTES.md)에 정리했습니다. 원본이나 런타임을 바꾸면 단일 HTML도 다시 빌드합니다.

## GPT Sites에 배포

정적 사이트 디렉터리는 `dist`입니다. 배포에 필요한 애플리케이션 파일은 `dist/index.html` 하나입니다. 새 버전을 배포하려면 원본을 변경한 뒤 `npm run build && npm test`로 이 파일을 다시 만들고, 갱신된 파일을 Sites의 정적 빌드로 올립니다.
