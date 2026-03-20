#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
# deploy_to_gcp.sh — Create & Deploy Always Free GCP VM
# ══════════════════════════════════════════════════════════════
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()   { echo -e "${CYAN}[GCP Deploy]${NC} $1"; }
ok()    { echo -e "${GREEN}  ✅ $1${NC}"; }
warn()  { echo -e "${YELLOW}  ⚠️  $1${NC}"; }

# Verify gcloud is installed
if ! command -v gcloud >/dev/null 2>&1; then
    echo -e "${RED}  ❌ gcloud CLI is not installed. Please read DEPLOY_GCP.md${NC}"
    exit 1
fi

INSTANCE_NAME="triconnect-signal"
ZONE=$(gcloud config get-value compute/zone 2>/dev/null)

# Fallback to standard Free Tier zone if not set
if [ -z "$ZONE" ]; then
    warn "No default zone set in gcloud. Using us-central1-a for Always Free tier."
    ZONE="us-central1-a"
fi

echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     TriConnect — GCP Auto-Provisioner        ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"

# 1. Firewall rules
log "Checking firewall rules for Port 8080..."
if ! gcloud compute firewall-rules describe allow-triconnect-8080; then
    gcloud compute firewall-rules create allow-triconnect-8080 \
        --allow tcp:8080 \
        --target-tags triconnect-node \
        --description "Allow inbound WebSocket traffic on port 8080"
    ok "Firewall rule created."
else
    ok "Firewall rule already exists."
fi

# 2. VM Creation
log "Provisioning Always Free e2-micro VM ($INSTANCE_NAME in $ZONE)..."
if ! gcloud compute instances describe $INSTANCE_NAME --zone=$ZONE; then
    gcloud compute instances create $INSTANCE_NAME \
        --machine-type=e2-micro \
        --zone=$ZONE \
        --image-family=ubuntu-2204-lts \
        --image-project=ubuntu-os-cloud \
        --tags=triconnect-node
    ok "VM securely created!"
else
    warn "VM $INSTANCE_NAME already exists, skipping creation..."
fi

# Need to wait briefly if VM was literally just created so SSH service is ready
log "Waiting 15 seconds for SSH to initialize on the new server..."
sleep 15

# 3. Code Transfer
log "Securely transferring signaling server code..."
gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --command="mkdir -p ~/signaling-server"
gcloud compute scp ./signaling-server/server.js ./signaling-server/package.json $INSTANCE_NAME:~/signaling-server/ --zone=$ZONE
ok "Code transferred."

# 4. Dependency installation and server launch
log "Installing Node.js & PM2, and launching server..."
gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --command="
    set -e
    
    # Install Node.js
    if ! command -v node >/dev/null 2>&1; then
        echo 'Installing Node.js 20...'
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    fi
    
    # Install PM2
    if ! command -v pm2 >/dev/null 2>&1; then
        echo 'Installing PM2...'
        sudo npm install -g pm2
    fi
    
    cd ~/signaling-server
    npm install --production
    
    # Restart the WebSocket server safely
    pm2 delete triconnect 2>/dev/null || true
    pm2 start server.js --name triconnect
    pm2 save
"
ok "Server successfully booted!"

# 5. Fetch External IP
EXT_IP=$(gcloud compute instances describe $INSTANCE_NAME --zone=$ZONE --format='get(networkInterfaces[0].accessConfigs[0].natIP)')

echo ""
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  GCP Deployment Complete! 🎉${NC}"
echo -e "${GREEN}  Update your src/js/app.js to connect to:${NC}"
echo -e "${GREEN}  ws://${EXT_IP}:8080${NC}"
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
