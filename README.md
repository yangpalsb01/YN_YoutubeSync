# 🎵 JukeSync — 동기화 BGM 주크박스

Roll20 쥬크박스와 같이, 여러 명이 함께 같은 음악을 실시간으로 들을 수 있는 웹 서비스입니다.

---

## 주요 기능

- ✅ 방 생성 / 코드로 입장 / 링크 공유
- ✅ 플레이리스트 생성, 이름 변경, 삭제
- ✅ YouTube 링크로 곡 추가
- ✅ 플레이리스트에 넣거나 개별 대기열에 추가
- ✅ 드래그 앤 드롭으로 플레이리스트/곡 순서 변경
- ✅ 셔플 / 반복(전체/한 곡) 기능
- ✅ **호스트만** 재생/일시정지/볼륨 제어 가능
- ✅ 게스트는 링크 또는 6자리 코드로 입장
- ✅ 영상 없이 BGM만 재생 (YouTube IFrame API)
- ✅ 실시간 동기화 (Socket.io)

---

## 로컬에서 실행하기

```bash
# 1. 의존성 설치
npm install

# 2. 서버 실행
npm start
# 또는
node server.js

# 3. 브라우저에서 접속
# http://localhost:4200
```

---

## Render.com 배포 방법

### 1단계: GitHub에 올리기

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/[계정명]/jukebox-sync.git
git push -u origin main
```

### 2단계: Render.com 설정

1. [render.com](https://render.com) 로그인
2. **New → Web Service** 클릭
3. GitHub 저장소 연결
4. 아래와 같이 설정:

| 항목 | 값 |
|------|-----|
| **Environment** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |

5. **Create Web Service** 클릭
6. 배포 완료 후 `https://your-app.onrender.com` 으로 접속!

---

## 사용법

### 방 만들기 (호스트)
1. 홈페이지에서 방 이름과 닉네임 입력 후 **방 만들기** 클릭
2. 방에 입장하면 상단에 **6자리 초대 코드** 표시
3. 코드나 링크를 친구에게 공유

### 친구 초대 (게스트)
- **코드**: 홈페이지에서 6자리 코드 입력
- **링크**: 방 URL 직접 접속
- 홈페이지의 "열린 방 목록"에서 입장

### 음악 재생
1. `+` 버튼으로 플레이리스트 생성
2. 플레이리스트의 `+` 버튼으로 YouTube 링크 입력해 곡 추가
3. 곡 옆 `▶` 버튼으로 재생 (호스트만 가능)
4. 상단 플레이어에서 셔플, 반복, 볼륨 조절

---

## 파일 구조

```
jukebox/
├── server.js          ← 서버 (Node.js + Socket.io)
├── package.json
├── public/
│   ├── index.html     ← 로비 (방 목록, 생성, 입장)
│   ├── room.html      ← 방 화면
│   ├── css/
│   │   └── style.css  ← 전체 스타일
│   └── js/
│       └── room.js    ← 방 클라이언트 로직
└── README.md
```

---

## 주의사항

- 서버를 재시작하면 방 목록과 플레이리스트가 초기화됩니다 (메모리 저장)
- 영구 저장이 필요하면 추후 SQLite 또는 MongoDB 연동 가능
- Render.com 무료 플랜은 15분 비활성 시 서버가 슬립 상태가 됩니다
