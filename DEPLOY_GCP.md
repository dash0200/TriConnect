# TriConnect — Google Cloud Platform (GCP) Deployment

Google Cloud offers an excellent "Always Free" tier that includes 1 non-preemptible `e2-micro` VM instance per month (specifically in the `us-west1`, `us-central1`, or `us-east1` regions).

Because the GCP CLI (`gcloud`) handles SSH keys and networking rules cleanly, we can completely automate creating the server, opening the firewall, and transferring your private code without dealing with GitHub tokens.

---

## Step 1: Install the Google Cloud CLI
First, install the Google Cloud SDK on your local machine.

**On Ubuntu / Debian Linux:**
```bash
## Add the Google Cloud package repository
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee -a /etc/apt/sources.list.d/google-cloud-sdk.list
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo apt-key --keyring /usr/share/keyrings/cloud.google.gpg add -

## Install the CLI
sudo apt-get update && sudo apt-get install google-cloud-cli
```
*(On Mac, use `brew install --cask google-cloud-sdk`. On Windows, download the installer from the Google Cloud SDK webpage).*

## Step 2: Initialize & Authenticate
Open your terminal and log in. This will open a web browser to authenticate your Google Account.
```bash
gcloud auth login
gcloud init
```
During `gcloud init`:
1. Select the project you created in the GCP Console.
2. Select your default zone. **(CRITICAL FOR FREE TIER: You must type the number for a zone in `us-central1`, `us-west1`, or `us-east1` — e.g. `us-central1-a`).**

## Step 3: Run the Auto-Deploy Script
I have created an automated deployment script called `deploy_to_gcp.sh` in your project folder. This script will:
- Automatically configure Google's firewall to allow Port 8080.
- Create your Always Free `e2-micro` virtual machine.
- Securely copy your signaling server files (bypassing the need for Private GitHub Keys on the server).
- Install Node.js, NPM, and PM2.
- Start the server permanently in the background.

```bash
chmod +x deploy_to_gcp.sh
./deploy_to_gcp.sh
```

## Final Step: Update Your Frontend
The script will output the **External IP** of your new server at the very end. Go back to your Tauri app code. Open `src/js/app.js` and update your URL!

```javascript
// Change this:
const SIGNALING_URL = 'ws://localhost:8080';

// To this (Using your new Google Cloud IP):
const SIGNALING_URL = 'ws://34.123.45.67:8080';
```
