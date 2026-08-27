# Pi Harbor (한국어)

[English](README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · 한국어 · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Pi Harbor은 Pi coding agent를 위한 오픈 소스 모바일 우선 웹 클라이언트입니다. 세션 확인과 계속하기, 프로젝트 생성, 이미지 미리보기, 여러 Pi Harbor 컴퓨터 전환을 지원합니다.

## 개인정보 보호

이 저장소에는 애플리케이션 코드와 일반 배포 템플릿만 있습니다. 토큰, 세션 로그, 프로젝트 파일, 비공개 URL, 계정 자격 증명, 모델 사용 기록, 사용량 또는 특정 컴퓨터 설정은 포함하지 않습니다. 토큰은 권한 `600`인 로컬 파일에 보관하고 HTTPS 게이트웨이를 사용하세요.

## 빠른 시작

```bash
git clone https://github.com/seehow624/pi-web.git
cd pi-web
mkdir -p ~/.config/pi-web
openssl rand -hex 32 > ~/.config/pi-web/token
chmod 600 ~/.config/pi-web/token
PI_WEB_TOKEN_FILE="$HOME/.config/pi-web/token" node server.js
```

각 컴퓨터에서 Pi Harbor을 실행하고 HTTPS 주소와 로컬 토큰으로 로그인합니다. 토큰을 Git, 채팅, 스크린샷 또는 로그에 넣지 마세요.

**Settings → Devices**에서 표시 이름과 HTTPS URL을 추가할 수 있습니다. `deploy/`의 launchd 템플릿으로 자동 업데이트를 설정할 수 있습니다.

```bash
npm run check
npm test
```

자세한 내용은 [영문 문서](README.md)를 참조하세요.
