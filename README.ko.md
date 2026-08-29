# Pi Harbor (한국어)

[English](README.md) · [중국어 간체](README.zh-Hans.md) · [중국어 번체](README.zh-Hant.md) · [日本語](README.ja.md) · 한국어 · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Pi Harbor은 Pi coding agent를 위한 오픈 소스 모바일 우선 웹 클라이언트입니다. 세션 확인과 계속하기, 프로젝트 생성, 이미지 미리보기, 여러 Pi Harbor 컴퓨터 전환을 지원합니다.

## 개인정보 보호

이 저장소에는 애플리케이션 코드와 일반 배포 템플릿만 있습니다. 토큰, 세션 로그, 프로젝트 파일, 비공개 URL, 계정 자격 증명, 모델 사용 기록, 사용량 또는 특정 컴퓨터 설정은 포함하지 않습니다. 토큰은 권한 `600`인 로컬 파일에 보관하고 HTTPS 게이트웨이를 사용하세요.

## 빠른 시작

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/pi-harbor/master/install.sh)"
```

Pi Harbor를 실행하는 컴퓨터에서 터미널을 열고 다음 명령으로 토큰을 확인하세요.

```bash
cat ~/.config/pi-harbor/token
```

로그인 화면에 붙여넣습니다. 다른 기기에서는 해당 호스트에서 토큰을 안전하게 가져오세요. `PI_HARBOR_TOKEN_FILE`을 명시적으로 설정했다면 기본 경로 대신 설정한 파일을 읽으세요. 토큰을 Git, 채팅, 스크린샷 또는 로그에 절대 넣지 마세요.

각 컴퓨터에 Pi Harbor를 설치하고 실행한 뒤 **Settings → Devices → Add device**에서 Tailscale 또는 HTTPS 주소를 추가하세요. 5분 동안 유효한 페어링 코드도 사용할 수 있습니다. 같은 Web 토큰을 사용하고 3140 포트를 공개하지 마세요. **Settings → Connection → Models & providers**에서 카탈로그 서비스, 계정/OAuth, API 키, 로컬 서비스 또는 사용자 지정 제공자를 선택한 다음 표시할 모델을 선택할 수 있습니다. `deploy/`의 launchd 템플릿으로 자동 업데이트를 설정할 수 있습니다.

```bash
npm run check
npm test
```

자세한 내용은 [영문 문서](README.md)를 참조하세요.
