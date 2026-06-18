-include .env
export

COMPOSE := docker compose
BUILD_FILES := -f docker-compose.yml -f docker-compose.build.yml
PUSH_SERVICES := api-1 frontend
PLATFORMS ?= linux/amd64,linux/arm64
VITE_API_BASE_URL ?= http://localhost:8080

.DEFAULT_GOAL := help
.PHONY: help build up-build run pull push release push-multiarch login down logs ps

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

build: ## Build images from source
	$(COMPOSE) $(BUILD_FILES) build

up-build: ## Build from source and start the stack in the background
	$(COMPOSE) $(BUILD_FILES) up --build -d

run: ## Start the stack from registry images in the background
	$(COMPOSE) up -d

pull: ## Pull images from the registry
	$(COMPOSE) pull

push: build ## Build and push project images (api + frontend) to the registry
	$(COMPOSE) push $(PUSH_SERVICES)

release: login push ## Log in, build, and push project images

push-multiarch: login ## Build and push multi-arch images via buildx
	docker buildx build --platform $(PLATFORMS) -t "$(API_IMAGE)" --push ./api
	docker buildx build --platform $(PLATFORMS) \
		--build-arg VITE_API_BASE_URL=$(VITE_API_BASE_URL) \
		-t "$(FRONTEND_IMAGE)" --push ./frontend

login: ## Log in to Docker Hub
	docker login

down: ## Stop and remove the stack
	$(COMPOSE) down

logs: ## Tail service logs
	$(COMPOSE) logs -f

ps: ## Show running services
	$(COMPOSE) ps
