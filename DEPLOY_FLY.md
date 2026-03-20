# How to Deploy the Signaling Server to Fly.io

Because your `signaling-server` sits in a subfolder alongside your desktop app, the easiest and most reliable way to deploy it to Fly.io is by using the Fly Command Line tool (`flyctl`). This allows you to specifically tell Fly.io to only look at the `signaling-server` folder and deploy the Docker image we already created.

Here is the step-by-step guide to get it running for free.

---

## Step 1: Install the Fly.io CLI
Open your terminal and install the `flyctl` command line tool:

```bash
# On Mac/Linux:
curl -L https://fly.io/install.sh | sh

# On Windows (PowerShell):
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

> **Note:** On Linux/Mac, you might need to add it to your PATH as the script suggests (e.g., `export FLYCTL_INSTALL="~/.fly"`, etc).

## Step 2: Login to Fly.io
In your terminal, log into the account you just created:

```bash
fly auth login
```
This will open a browser window asking you to authorize the CLI.

## Step 3: Launch the App
1. Navigate directly into the signaling server folder in your terminal:
   ```bash
   cd ~/Documents/TriConnect/signaling-server
   ```
2. Initialize the Fly application:
   ```bash
   fly launch
   ```
3. A wizard will appear in your terminal:
   - **App Name:** Leave blank (it will generate a unique one) or choose something like `triconnect-signal`.
   - **Region:** Choose the region closest to you.
   - **Postgres Database / Redis:** Press `No` (we process everything in memory!).
   - **Deploy now?:** Press `Yes`

## Step 4: Exposing the WebSocket Port
Because we are using WebSockets on port `8080`, Fly.io needs to know to route HTTP/WebSockets there. 

Open the newly generated `fly.toml` file inside your `signaling-server` folder. Find the `[http_service]` section and ensure `internal_port` is set to `8080`:

```toml
[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false 
  auto_start_machines = true
  min_machines_running = 1
```

> **Crucial Change:** Change `auto_stop_machines` to `false` and set `min_machines_running` to `1`. Since WebSockets are long-lived and require an active server, you do **not** want Fly.io putting your app to sleep to save money, otherwise peers won't be able to connect! (It's still free within the Hobby limit).

## Step 5: Final Deploy
Run the deploy command one last time to push the Docker container to Fly's servers:

```bash
fly deploy
```

Once it finishes, it will give you a URL like `https://triconnect-signal.fly.dev`.

---

## Final Step: Update Your Frontend
Go back to your Tauri app code. Open `src/js/app.js` and change the development WebSocket URL to your new secure production URL:

```javascript
// Change this:
const SIGNALING_URL = 'ws://localhost:8080';

// To this (Notice the 'wss://' for secure WebSockets!):
const SIGNALING_URL = 'wss://triconnect-signal.fly.dev';
```

Now, anyone who downloads your desktop app will automatically connect to your cloud signaling server!
