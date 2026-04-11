SOURCEDIR=./src
BASEDIR=./app

# Inicia o site para disponibilidade do plugin
shared:
	@python3 ${SOURCEDIR}/server.py 4200 ${BASEDIR}/shared

# Inicia o site de Vendas com CORS habilitado
vendas:
	@python3 ${SOURCEDIR}/server.py 4210 ${BASEDIR}/vendas

# Inicia o site de Estoque com CORS habilitado
estoque:
	@python3 ${SOURCEDIR}/server.py 4220 ${BASEDIR}/estoque

# Inicia os dois sites em paralelo (dois processos em background)
start:
	@echo ""
	@echo "  Iniciando Plugin.            em http://localhost:4200"
	@echo "  Iniciando Vendas.            em http://localhost:4210"
	@echo "  Iniciando Estoque.           em http://localhost:4220"
	@echo ""
	@python3 ${SOURCEDIR}/server.py 4200 ${BASEDIR}/shared & \
	 python3 ${SOURCEDIR}/server.py 4210 ${BASEDIR}/vendas & \
	 python3 ${SOURCEDIR}/server.py 4220 ${BASEDIR}/estoque & \
	 wait;

# Encerra qualquer processo nas portas usadas
stop:
	@echo "  Encerrando processos nas portas 4200, 4210 e 4220..."
	@-lsof -ti tcp:4200 | xargs kill 2>/dev/null || true
	@-lsof -ti tcp:4210 | xargs kill 2>/dev/null || true
	@-lsof -ti tcp:4220 | xargs kill 2>/dev/null || true
	@echo "  Pronto."

.PHONY: shared vendas estoque start stop
