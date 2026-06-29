# SWAT

[English](README.md) | [한국어](README.ko.md)

계근 관련 API의 TPS 확장성을 검증하기 위한 성능 인증 테스트베드입니다.

## 서비스

- `api`: 계근증 이미지 업로드와 계근 데이터 엔드포인트를 제공하는 Go API 서버.
- `frontend`: API 스모크 테스트와 부하 테스트를 실행하는 React/Vite 웹 콘솔.
- `haproxy`: 5개의 API 컨테이너 앞단에 있는 로드 밸런서.

## API 시작

### 로컬 실행

```sh
cd api
go run ./cmd/server
```

### HAProxy와 프론트엔드를 포함한 Docker Compose 실행

`docker-compose.yml`은 이미지만 참조하므로 미리 빌드된 Docker Hub 이미지로 실행할 수 있습니다.
`docker-compose.build.yml`은 소스에서 빌드하기 위한 build context를 추가합니다.

로컬에서 소스로 빌드하고 실행:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

업로드 크기 제한을 바이트 단위로 변경:

```sh
MAX_UPLOAD_BYTES=150000 docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

공개 API 엔드포인트는 HAProxy의 `http://localhost:8080`입니다.
프론트엔드는 `http://localhost:3000`에서 제공됩니다.

```sh
curl -i http://localhost:8080/health
```

HAProxy 통계는 `http://localhost:8404`에서 확인할 수 있습니다.

### 모니터링

Docker Compose 스택을 실행하면 Prometheus(`http://localhost:9090`)와 Grafana(`http://localhost:3000`, 기본 계정 `admin` / `swat`)가 함께 시작됩니다. 인증 지표와 PromQL 예시는 `docs/monitoring.md`를 참고하세요.

### OCR 모드

계근증 업로드 경로는 외부 OCR 서비스로 이미지를 전달할 수 있으며, 부하 테스트와 인증을 분리해서 수행할 수 있도록 두 가지 모드를 제공합니다.

- 비동기: `POST /api/weighing-slip/upload`는 즉시 응답하고 OCR은 백그라운드에서 실행합니다. 결과는 `GET /api/weighing-slip/ocr-result/{uploadId}`로 조회합니다.
- 동기: `POST /api/weighing-slip/upload-sync`는 OCR을 요청 경로에서 직접 실행하고, 파싱 결과와 지연 시간을 응답에 포함합니다.

OCR을 사용하려면 `.env` 또는 환경 변수에 `OCR_API_URL`을 설정합니다. 비워 두면 OCR 전달이 비활성화됩니다. 전체 `OCR_*` 설정은 `api/README.md`를 참고하세요.
프론트엔드 단일 업로드 패널에는 OCR 모드 토글이 있고, 부하 테스트 패널에는 "이미지 업로드 (비동기 OCR)"와 "이미지 업로드 (동기 OCR)" 테스트 종류가 있습니다.

### Makefile 단축 명령

`Makefile`은 자주 쓰는 Docker 작업을 감쌉니다. `.env`를 자동으로 읽으므로 먼저 `API_IMAGE` / `FRONTEND_IMAGE`를 설정하세요. 전체 목록은 `make help`로 확인할 수 있습니다.

```sh
make build           # 소스에서 이미지 빌드
make up-build        # 소스에서 빌드하고 백그라운드 실행 (-d)
make push            # api + frontend 이미지 빌드 후 push
make release         # docker login + build + push
make push-multiarch  # buildx multi-arch 빌드 후 push
make pull            # 레지스트리에서 이미지 pull
make run             # 레지스트리 이미지로 백그라운드 실행 (-d)
make down            # 스택 중지 및 제거
make logs            # 서비스 로그 tail
```

### Docker Hub에 이미지 게시

먼저 이미지 참조를 설정합니다. `.env.example`을 `.env`로 복사하고 `<dockerhub-username>`을 바꾸거나, 아래처럼 직접 export합니다.

```sh
export API_IMAGE=<dockerhub-username>/swat-api:1.0.0
export FRONTEND_IMAGE=<dockerhub-username>/swat-frontend:1.0.0
```

로그인한 뒤 프로젝트 이미지를 빌드하고 push합니다.

```sh
docker login
docker compose -f docker-compose.yml -f docker-compose.build.yml build api-1 frontend
docker push "$API_IMAGE"
docker push "$FRONTEND_IMAGE"
```

5개의 `api-*` 서비스는 같은 `API_IMAGE`를 공유하므로, API 이미지는 한 번만 빌드/push하면 됩니다.

참고: Docker Desktop이 containerd image store를 사용하는 경우 `docker compose push`가 buildkit manifest list를 업로드하지 못할 수 있습니다. 그래서 `make push`처럼 `docker push`를 직접 사용하는 방식을 권장합니다.

Apple Silicon에서 amd64 서버용 이미지를 빌드하는 것처럼 서버와 빌드 머신의 CPU 아키텍처가 다르면 buildx로 multi-arch 이미지를 빌드하고 push합니다.

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -t "$API_IMAGE" --push ./api
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg VITE_API_BASE_URL=http://localhost:8080 \
  -t "$FRONTEND_IMAGE" --push ./frontend
```

### Docker Hub 이미지로 원격 실행

대상 서버에서 동일한 `API_IMAGE` / `FRONTEND_IMAGE` 값을 `.env` 또는 `export`로 설정한 뒤, 빌드 없이 pull하고 실행합니다.

```sh
docker compose pull
docker compose up -d
```

이 방식은 `docker-compose.yml`만 사용하므로 build context가 필요 없습니다. 다만 HAProxy가 `infra/haproxy/haproxy.cfg`를 bind mount하므로, 서버에도 저장소 체크아웃이 있거나 해당 파일이 compose 파일 옆에 있어야 합니다.

`VITE_API_BASE_URL`은 프론트엔드 이미지 빌드 시 정적 번들에 포함됩니다. 브라우저에서 접근할 API URL이 바뀌면 프론트엔드 이미지를 다시 빌드하고 게시해야 합니다.

## 프론트엔드 시작

```sh
cd frontend
npm install
npm run dev
```

프론트엔드는 기본적으로 `http://localhost:8080`으로 API를 호출합니다. 필요하면 `VITE_API_BASE_URL`로 변경합니다.

### 프론트엔드 컨테이너만 실행

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build frontend
```

브라우저에서 접근할 프론트엔드 포트를 변경:

```sh
FRONTEND_PORT=5173 docker compose -f docker-compose.yml -f docker-compose.build.yml up --build frontend
```

컨테이너 빌드에서는 `VITE_API_BASE_URL`이 정적 프론트엔드 번들에 포함됩니다.

```sh
VITE_API_BASE_URL=http://172.16.0.90:8080 docker compose -f docker-compose.yml -f docker-compose.build.yml up --build frontend
```

## 이미지 업로드 부하 테스트

HAProxy를 경유하는 로컬 최대 처리량 테스트:

```sh
python3 load-test/upload_image.py \
  --url http://localhost:8080 \
  --workers 50 \
  --duration 20
```

스크립트는 기본적으로 `sample/84b42905c32037.jpg`를 사용하므로 `load-test/` 디렉터리에서도 실행할 수 있습니다.

```sh
cd load-test
python3 upload_image.py --url http://localhost:8080 --workers 50 --duration 20
```

실제 네트워크 구간을 포함하려면 같은 네트워크의 다른 머신에서 실행합니다.

```sh
python3 upload_image.py \
  --url http://172.16.0.90:8080 \
  --image 84b42905c32037.jpg \
  --workers 50 \
  --duration 20
```

각 논리 워커가 초당 1건씩 보내는 인증 모델 실행:

```sh
python3 load-test/upload_image.py \
  --url http://localhost:8080 \
  --workers 100 \
  --rate-per-worker 1 \
  --duration 600
```

## 계근 데이터 가상 생성기

실제 CSV 분포 프로필을 기반으로 샘플 계근 JSON을 생성하고, API로 전송한 뒤 전후 비교 파일을 다운로드할 수 있습니다.

웹 콘솔의 사이드바 **계근 데이터** 메뉴는 샘플 생성과 응답 비교용입니다. 지속적인 TPS 부하 테스트 용도가 아닙니다.

최대 처리량 TPS 확인은 웹 콘솔의 **부하 테스트** 패널에서 **계근 데이터 단건** 또는 **계근 데이터 벌크**를 선택해서 실행합니다. 계근 데이터 테스트를 선택하면 패널은 closed-loop 최대 처리량 모드로 전환되고, 샘플 화면과 동일한 가상 계근 데이터 생성기를 사용합니다. 실행 중 요청 수, 현재 TPS, 평균 TPS를 확인할 수 있으며, 테스트 종료 후 전송 데이터 JSON, 실제 응답 JSON, 요청/응답 비교 JSON을 다운로드할 수 있습니다.

CLI:

```sh
# 생성만 수행
python3 load-test/weighing_data.py generate --count 10 --output load-test/out/generated.json

# 생성 + 전송 + 비교 파일 출력
python3 load-test/weighing_data.py run \
  --url http://192.168.0.9:19090 \
  --count 10 \
  --test-run-id CERT-WEIGHING-001 \
  --output-dir load-test/out

# 서버에 저장된 레코드 조회
python3 load-test/weighing_data.py fetch \
  --url http://192.168.0.9:19090 \
  --test-run-id CERT-WEIGHING-001 \
  --output load-test/out/server.json
```
