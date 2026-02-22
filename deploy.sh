#!/bin/bash
set -e

# --- Load environment variables ---
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
else
    echo "Error: .env file not found. Please create one from .env.example."
    exit 1
fi

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# --- Database tools ---
DB_CMD="psql -h ${POSTGRES_HOST:-localhost} -p ${POSTGRES_PORT:-5432} -U $POSTGRES_USER -d $POSTGRES_DATABASE"
DB_CMD_DEFAULT="psql -h ${POSTGRES_HOST:-localhost} -p ${POSTGRES_PORT:-5432} -U $POSTGRES_USER -d postgres"
export PGPASSWORD="$POSTGRES_PASSWORD"

# --- 1. Auto-create database ---
create_db_if_not_exists() {
    if ! $DB_CMD_DEFAULT -tAc "SELECT 1 FROM pg_database WHERE datname='$POSTGRES_DATABASE'" 2>/dev/null | grep -q 1; then
        log_info "Creating database: $POSTGRES_DATABASE ..."
        $DB_CMD_DEFAULT -c "CREATE DATABASE \"$POSTGRES_DATABASE\""
    else
        log_info "Database $POSTGRES_DATABASE already exists."
    fi
}

# --- 2. Run Prisma migrations ---
migrate() {
    log_info "Running Prisma migrations..."
    npx prisma migrate deploy
    log_info "Migrations complete."
}

# --- 3. Init (first time setup) ---
init() {
    log_info "Initializing system..."
    docker compose -f docker-compose.dev.yml up -d
    log_info "Waiting for services to start..."
    sleep 5
    create_db_if_not_exists
    migrate
    log_info "Init complete! Run 'pnpm run server' to start the app."
}

# --- 4. Update (git pull + rebuild) ---
update() {
    log_info "Updating code..."
    local old_commit
    old_commit=$(git rev-parse HEAD)
    git pull

    local new_commit
    new_commit=$(git rev-parse HEAD)

    if [ "$old_commit" = "$new_commit" ]; then
        log_info "Already up to date."
        return
    fi

    # Check if migrations changed
    if git diff --name-only "$old_commit" "$new_commit" | grep -q "^prisma/migrations/"; then
        migrate
    fi

    log_info "Rebuilding and restarting services..."
    docker compose up -d --build --remove-orphans
    log_info "Update complete!"
}

# --- Command routing ---
case "${1:-}" in
    init)    init ;;
    migrate) migrate ;;
    update)  update ;;
    stop)    docker compose down ;;
    status)  docker compose ps ;;
    *)       echo "Usage: $0 {init|migrate|update|stop|status}" ;;
esac
