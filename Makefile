SOURCEDIR=./src
BASEDIR=./app
DD_ENV ?= local
DD_AGENT_HOST ?= 127.0.0.1
DD_DOGSTATSD_PORT ?= 8125
DD_LOGS_JSON ?= 0
DD_METRICS_ENABLED ?= 1
DD_VERSION ?= dev
OBSIDIAN_FOLDER=/Users/raysouz/Library/Mobile\ Documents/iCloud\~md\~obsidian/Documents/.obsidian/plugins/flowbridge

DATADOG_ENV=DD_ENV=${DD_ENV} DD_AGENT_HOST=${DD_AGENT_HOST} DD_DOGSTATSD_PORT=${DD_DOGSTATSD_PORT} DD_LOGS_JSON=${DD_LOGS_JSON} DD_METRICS_ENABLED=${DD_METRICS_ENABLED} DD_VERSION=${DD_VERSION}

# Inicia o site para disponibilidade do plugin
shared:
	@${DATADOG_ENV} DD_SERVICE=flowbridge-shared python3 ${SOURCEDIR}/server.py 4200 ${BASEDIR}/shared

# Inicia o site de Vendas com CORS habilitado
vendas:
	@${DATADOG_ENV} DD_SERVICE=flowbridge-vendas python3 ${SOURCEDIR}/server.py 4210 ${BASEDIR}/vendas

# Inicia o site de Estoque com CORS habilitado
estoque:
	@${DATADOG_ENV} DD_SERVICE=flowbridge-estoque python3 ${SOURCEDIR}/server.py 4220 ${BASEDIR}/estoque

studio:
	@${DATADOG_ENV} DD_SERVICE=flowbridge-studio python3 ${SOURCEDIR}/server.py 4230 ./studio

# Inicia os dois sites em paralelo (dois processos em background)
start:
	@echo ""
	@echo "  Iniciando Plugin.            em http://localhost:4200"
	@echo "  Iniciando Vendas.            em http://localhost:4210"
	@echo "  Iniciando Estoque.           em http://localhost:4220"
	@echo "  Iniciando Studio.            em http://localhost:4230"
	@echo ""
	@${DATADOG_ENV} DD_SERVICE=flowbridge-shared python3 ${SOURCEDIR}/server.py 4200 ${BASEDIR}/shared & \
	 ${DATADOG_ENV} DD_SERVICE=flowbridge-vendas python3 ${SOURCEDIR}/server.py 4210 ${BASEDIR}/vendas & \
	 ${DATADOG_ENV} DD_SERVICE=flowbridge-estoque python3 ${SOURCEDIR}/server.py 4220 ${BASEDIR}/estoque & \
	 ${DATADOG_ENV} DD_SERVICE=flowbridge-studio python3 ${SOURCEDIR}/server.py 4230 ./studio & \
	 wait;

# Encerra qualquer processo nas portas usadas
stop:
	@echo "  Encerrando processos nas portas 4200, 4210, 4220 e 4230..."
	@-lsof -ti tcp:4200 | xargs kill 2>/dev/null || true
	@-lsof -ti tcp:4210 | xargs kill 2>/dev/null || true
	@-lsof -ti tcp:4220 | xargs kill 2>/dev/null || true
	@-lsof -ti tcp:4230 | xargs kill 2>/dev/null || true
	@echo "  Pronto."

# Gera o plugin flowbridge para obsidian
build:
	@set -e; \
	 mkdir -p dist ${OBSIDIAN_FOLDER}; \
	 npm --prefix obsidian install; \
	 npm --prefix obsidian run build; \
	 cp obsidian/manifest.json dist/manifest.json; \
	 cp obsidian/styles.css dist/styles.css; \
	 cp dist/* ${OBSIDIAN_FOLDER}; \
	 echo "  Plugin copiado para ${OBSIDIAN_FOLDER}"; \
	 echo "  Recarregue o plugin Flowbridge no Obsidian para aplicar a nova build.";

gitpage:
	@cd app/gitpage; \
	 npm start

.PHONY: shared vendas estoque studio start stop build gitpage
