// The shopper catalog for the "Hire AI shoppers" page: résumés for the hosted
// AI shoppers, the local runtimes, the local models and the GPU table behind
// "Suggest a local shopper". Loaded as-is by the browser and by the server
// (GET /api/shoppers/suggest), so no imports.
//
// Researched 2026-10-29 from each provider's own docs and pricing pages, the
// Ollama model library (download sizes), and three independent local-LLM
// hardware guides (ctaio.dev, insiderllm.com, llmconfigurator.com). Sources
// are listed in README.md. Prices are per million tokens (input / output).

export const RESEARCHED = "2026-10-29";
export const SITE = "https://wishlistmarket.pages.dev";

// ---------- hosted shoppers (run on the provider's servers) ----------

export const HOSTED = {
  gemini: {
    title: "Google Gemini", tagline: "Searches Google itself. The default shopper.",
    strengths: ["Google Search built in", "Free tier with daily limits in AI Studio", "Fast and cheap Flash models"],
    cost: "Free tier with daily limits; paid use is billed in Google AI Studio",
    models: [["gemini-3.8-flash", "Gemini 3.8 Flash (best all-round)"], ["gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite (cheapest)"]],
    steps: ["Sign in at aistudio.google.com with a Google account.", "Click Get API key, then Create API key.", "Paste the key here."],
    popular: 1,
  },
  openai: {
    title: "OpenAI (ChatGPT models)", tagline: "GPT models with OpenAI's own web search.",
    strengths: ["Web search built in", "Strict JSON output", "Strong at comparing products"],
    cost: "gpt-6.1-sol $2 / $10; gpt-6-luna $0.10 / $0.50, plus web search calls. Needs prepaid credit.",
    models: [["gpt-6.1-sol", "GPT-6.1 Sol (balanced)"], ["gpt-6.1-terra", "GPT-6.1 Terra (cheaper)"], ["gpt-6-luna", "GPT-6 Luna (cheapest)"], ["gpt-6-astra", "GPT-6 Astra (flagship, $10 / $50)"]],
    steps: ["Sign in at platform.openai.com.", "Add a little credit under Settings, Billing (a ChatGPT subscription doesn't cover the API).", "Create a key under API keys and paste it here."],
    popular: 2,
  },
  anthropic: {
    title: "Anthropic Claude", tagline: "Claude with Anthropic's web search tool.",
    strengths: ["Web search built in", "Careful, honest product write-ups", "Strict JSON output"],
    cost: "Opus 5.5 $4 / $20; Sonnet 5.5 $2 / $10; Haiku 5.5 $0.10 / $0.50, plus web search use. Needs prepaid credit.",
    models: [["claude-opus-5-5", "Claude Opus 5.5 (best)"], ["claude-sonnet-5-5", "Claude Sonnet 5.5"], ["claude-haiku-5-5", "Claude Haiku 5.5 (cheapest)"]],
    steps: ["Sign in at platform.claude.com.", "Add credit under Billing.", "Create a key under Settings, API keys and paste it here."],
    popular: 3,
  },
  xai: {
    title: "xAI Grok", tagline: "Grok with xAI's live web search.",
    strengths: ["Web search built in", "Very long memory (500K tokens)"],
    cost: "grok-4.7 $2 / $6, plus web search use",
    models: [["grok-4.7", "Grok 4.7"]],
    steps: ["Sign in at console.x.ai.", "Add credit, then create an API key.", "Paste the key here."],
    popular: 6,
  },
  perplexity: {
    title: "Perplexity", tagline: "A search company's agent: searches first, then answers.",
    strengths: ["Search is its specialty", "Choose GPT, Claude or Sonar models with one key"],
    cost: "Model tokens plus $1 per 1,000 fast searches",
    models: [["openai/gpt-6.1-sol", "GPT-6.1 Sol via Perplexity"], ["openai/gpt-6-luna", "GPT-6 Luna via Perplexity (cheapest)"], ["perplexity/sonar", "Perplexity Sonar"]],
    steps: ["Sign in at console.perplexity.ai.", "Add credit, then create an API key (starts with pplx-).", "Paste the key here."],
    popular: 5,
  },
  openrouter: {
    title: "OpenRouter", tagline: "One key for 400+ models from every lab, with web search.",
    strengths: ["Try many models with one key", "Web search plugin", "Some free models"],
    cost: "Each model's own price, plus the web plugin's search fee",
    models: [["google/gemini-3.8-flash", "Gemini 3.8 Flash"], ["openai/gpt-6-luna", "GPT-6 Luna"], ["anthropic/claude-opus-5.5", "Claude Opus 5.5"], ["x-ai/grok-4.7", "Grok 4.7"], ["deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash"]],
    steps: ["Sign in at openrouter.ai.", "Add credit, then create a key under Keys (starts with sk-or-).", "Paste the key here."],
    popular: 4,
  },
  deepseek: {
    title: "DeepSeek", tagline: "Very low cost. Shops with a search helper.",
    strengths: ["Among the cheapest strong models", "Thinking mode"],
    cost: "Very low per-token prices (see api-docs.deepseek.com); needs a search helper key too",
    models: [["deepseek-flash", "DeepSeek V4.1 Flash"], ["deepseek-v4-pro", "DeepSeek V4 Pro"]],
    steps: ["Sign in at platform.deepseek.com and top up a little credit.", "Create an API key and paste it here.", "Hire a search helper below (Tavily is free)."],
    popular: 7,
  },
  mistral: {
    title: "Mistral", tagline: "European models. Shops with a search helper.",
    strengths: ["EU-hosted", "Strict JSON output"],
    cost: "See mistral.ai/pricing; needs a search helper key too",
    models: [["mistral-medium-latest", "Mistral Medium (latest)"], ["mistral-small-latest", "Mistral Small (latest, cheaper)"]],
    steps: ["Sign in at console.mistral.ai and choose a plan.", "Create an API key and paste it here.", "Hire a search helper below (Tavily is free)."],
    popular: 9,
  },
  groq: {
    title: "Groq", tagline: "Open models at very high speed. Shops with a search helper.",
    strengths: ["Answers in seconds", "Free plan with rate limits"],
    cost: "gpt-oss-120b $0.15 / $0.60; free plan with rate limits; needs a search helper key too",
    models: [["openai/gpt-oss-120b", "gpt-oss 120B"], ["openai/gpt-oss-20b", "gpt-oss 20B (faster)"]],
    steps: ["Sign in at console.groq.com.", "Create an API key (starts with gsk_) and paste it here.", "Hire a search helper below (Tavily is free)."],
    popular: 8,
  },
  "ollama-cloud": {
    title: "Ollama Cloud", tagline: "Big open models on Ollama's servers. One key covers the model and web search.",
    strengths: ["No GPU needed", "The same key runs Ollama web search", "Open models (gpt-oss, Gemma 4, DeepSeek)"],
    cost: "Pay as you go, or Pro $20 / month; gpt-oss:120b $0.15 / $0.60",
    models: [["gpt-oss:120b", "gpt-oss 120B"], ["gpt-oss:20b", "gpt-oss 20B (faster)"], ["gemma4:31b", "Gemma 4 31B"], ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash"]],
    steps: ["Sign in at ollama.com.", "Create a key under Settings, Keys and paste it here.", "That's it: web search uses the same key."],
    popular: 10,
  },
  custom: {
    title: "Other online server", tagline: "Any OpenAI-compatible server on the internet (Together, Fireworks, your own vLLM behind HTTPS).",
    strengths: ["Bring any model", "Key is optional"],
    cost: "Whatever that server charges; needs a search helper key too",
    models: [],
    steps: ["Enter the server's https address (ending in /v1).", "Add its key if it needs one.", "Load its model list and pick a model.", "Hire a search helper below."],
    popular: 11,
  },
};

// ---------- search helpers (for shoppers without their own search) ----------

export const SEARCH_INFO = {
  tavily: { steps: ["Sign up at app.tavily.com (no card needed).", "Copy the API key (starts with tvly-) and paste it here."] },
  brave: { steps: ["Sign up at api-dashboard.search.brave.com and pick the Search plan (needs a card; $5 of searches free each month).", "Create a key under API Keys and paste it here."] },
  perplexity: { steps: ["Use the same pplx- key as the Perplexity shopper, or make one at console.perplexity.ai."] },
  ollama: { steps: ["Sign in at ollama.com (free).", "Create a key under Settings, Keys and paste it here."] },
};

// ---------- local runtimes (run on the user's own computer) ----------
// A step is plain text, or [text, command to copy].

const ORIGIN = SITE;
export const LOCAL_RUNTIMES = {
  "ollama-local": {
    title: "Ollama on this computer", api: "ollama", base: "http://localhost:11434",
    tagline: "Free and private. Runs open models on your own graphics card.",
    get: "https://ollama.com/download",
    steps: {
      windows: [
        "Install Ollama from ollama.com/download.",
        "Quit Ollama from the tray icon (right-click, Quit Ollama).",
        ["Open PowerShell and run:", `setx OLLAMA_ORIGINS "${ORIGIN}"`],
        "Start Ollama again from the Start menu.",
      ],
      mac: [
        "Install Ollama from ollama.com/download.",
        ["Open Terminal and run:", `launchctl setenv OLLAMA_ORIGINS "${ORIGIN}"`],
        "Quit Ollama from the menu bar and open it again.",
      ],
      linux: [
        ["Install:", "curl -fsSL https://ollama.com/install.sh | sh"],
        ["Run:", "sudo systemctl edit ollama.service"],
        ["Add these two lines, then save:", `[Service]\nEnvironment="OLLAMA_ORIGINS=${ORIGIN}"`],
        ["Run:", "sudo systemctl daemon-reload && sudo systemctl restart ollama"],
      ],
    },
    why: "OLLAMA_ORIGINS lets this site talk to Ollama. Without it Ollama only answers apps on the computer itself.",
    pull: tag => `ollama pull ${tag}`,
  },
  lmstudio: {
    title: "LM Studio on this computer", api: "openai", base: "http://localhost:1234/v1",
    tagline: "Free app with a model browser. Best pick for AMD RX 6000 cards on Windows and Intel Arc.",
    get: "https://lmstudio.ai/download",
    steps: {
      all: [
        "Install LM Studio from lmstudio.ai/download and download a model in its Discover tab.",
        "Open the Developer tab, open Server Settings and turn on Enable CORS.",
        ["Turn the server on (Status: Running), or run:", "lms server start --cors"],
        "Load your model with a context length of at least 16384 (the default 4096 is too short for shopping lists).",
      ],
    },
    why: "Enable CORS lets this site talk to LM Studio's server on port 1234.",
  },
  "local-openai": {
    title: "Other local server", api: "openai", base: "http://localhost:8080/v1",
    tagline: "llama.cpp, vLLM, Jan, LocalAI or anything with an OpenAI-style /v1 address.",
    steps: {
      all: [
        ["Start your server with a context of at least 16384 tokens, for example:", "llama-server -m model.gguf -c 16384 --port 8080"],
        `Make sure it allows requests from ${ORIGIN} (CORS). llama.cpp's server and vLLM allow them by default.`,
        "Enter its address below (ending in /v1).",
      ],
    },
    why: "The page talks to the server straight from your browser.",
  },
};

export const LOCAL_NOTES = [
  "Local shoppers work from a browser on the same computer as the model (Chrome, Edge or Firefox). Your phone can't reach them.",
  "Chrome and Edge ask once whether this site may use apps on your device. Click Allow.",
  "The model runs on your computer. Web searches still go through your search helper, and the Market checks every link before a list is saved.",
];

// ---------- local models ----------
// need: GB of graphics memory to run fully on the GPU at Q4 with a 16K
// context (download size + room for the context). size: Ollama download.
// score: how well it does the shopping job (following the JSON schema,
// picking only from search results, sensible ranking), 0-100, from the
// guides above and its tool-use / instruction-following results.
// moe: mixture-of-experts, so it can spill to system RAM and stay usable;
// stretch = the least GPU memory (and system RAM) for that.

export const LOCAL_MODELS = [
  { tag: "qwen3.5:122b", name: "Qwen 3.5 122B-A10B", maker: "Alibaba", size: 81, need: 88, score: 95, moe: true, note: "Workstation-class. Excellent at following the list format." },
  { tag: "gpt-oss:120b", name: "gpt-oss 120B", maker: "OpenAI", size: 65, need: 70, score: 96, moe: true, stretch: { vram: 24, ram: 64 }, note: "OpenAI's open model. Top reasoning; built for tool use and JSON." },
  { tag: "qwen3.8:27b", name: "Qwen 3.8 27B", maker: "Alibaba", size: 18, need: 21, score: 95, note: "Best all-round local model for 24 GB cards today." },
  { tag: "qwen3.6:35b", name: "Qwen 3.6 35B-A3B", maker: "Alibaba", size: 24, need: 25, score: 93, moe: true, stretch: { vram: 12, ram: 32 }, note: "Fast for its size (only 3B active). Spills to RAM well." },
  { tag: "gemma4:31b", name: "Gemma 4 31B", maker: "Google", size: 20, need: 22, score: 92, note: "Google's strongest open model. Clear, careful write-ups." },
  { tag: "qwen3.6:27b", name: "Qwen 3.6 27B", maker: "Alibaba", size: 19, need: 21, score: 92, note: "Very reliable JSON and ranking." },
  { tag: "gemma4:26b", name: "Gemma 4 26B-A4B", maker: "Google", size: 18, need: 20, score: 90, moe: true, stretch: { vram: 10, ram: 32 }, note: "Quick mixture-of-experts Gemma." },
  { tag: "glm-4.7-flash", name: "GLM 4.7 Flash (30B-A3B)", maker: "Z.ai", size: 19, need: 21, score: 89, moe: true, stretch: { vram: 12, ram: 32 }, note: "Strong at tool use and agent work." },
  { tag: "gpt-oss:20b", name: "gpt-oss 20B", maker: "OpenAI", size: 14, need: 15, score: 88, moe: true, stretch: { vram: 8, ram: 24 }, note: "Runs in 16 GB. Built for tool use and structured output." },
  { tag: "nemotron-3-nano:30b", name: "Nemotron 3 Nano 30B", maker: "NVIDIA", size: 24, need: 22, score: 87, moe: true, stretch: { vram: 12, ram: 32 }, note: "Long memory (up to 1M tokens)." },
  { tag: "mistral-small3.2:24b", name: "Mistral Small 3.2 24B", maker: "Mistral", size: 15, need: 17, score: 84, note: "Solid, plain-spoken all-rounder." },
  { tag: "gemma4:12b", name: "Gemma 4 12B", maker: "Google", size: 8, need: 10, score: 81, note: "Best fit for 10-12 GB cards." },
  { tag: "ministral-3:14b", name: "Ministral 3 14B", maker: "Mistral", size: 9.1, need: 11, score: 80, note: "Good JSON discipline for its size." },
  { tag: "qwen3.5:9b", name: "Qwen 3.5 9B", maker: "Alibaba", size: 7.6, need: 8, score: 80, note: "Best pick for 8 GB cards." },
  { tag: "ministral-3:8b", name: "Ministral 3 8B", maker: "Mistral", size: 6, need: 8, score: 74, note: "Light and steady." },
  { tag: "gemma4:e4b", name: "Gemma 4 E4B", maker: "Google", size: 9.5, need: 8, score: 72, note: "Made for laptops and small cards." },
  { tag: "llama3.1:8b", name: "Llama 3.1 8B", maker: "Meta", size: 4.9, need: 6.5, score: 68, note: "Older but dependable." },
  { tag: "qwen3.5:4b", name: "Qwen 3.5 4B", maker: "Alibaba", size: 4, need: 5, score: 68, note: "Surprisingly capable for 6 GB cards." },
  { tag: "nemotron-3-nano:4b", name: "Nemotron 3 Nano 4B", maker: "NVIDIA", size: 2.9, need: 4, score: 66, note: "Small and quick." },
  { tag: "phi4-mini", name: "Phi-4 Mini 3.8B", maker: "Microsoft", size: 2.5, need: 4, score: 58, note: "Basic lists only." },
  { tag: "qwen3.5:2b", name: "Qwen 3.5 2B", maker: "Alibaba", size: 3.1, need: 4, score: 56, note: "Basic lists only." },
  { tag: "llama3.2:3b", name: "Llama 3.2 3B", maker: "Meta", size: 2, need: 3, score: 55, note: "Basic lists only." },
  { tag: "granite4:3b", name: "Granite 4 3B", maker: "IBM", size: 2.1, need: 3, score: 55, note: "Basic lists only." },
];

export const MIN_SCORE = 55;

// ---------- graphics cards ----------
// [name, GB, vendor]; vendor: nvidia | amd | intel | apple | unified (AMD Strix Halo, DGX Spark).

const g = (vendor, rows) => rows.map(([name, gb, extra]) => ({ name, gb, vendor, ...(extra || {}) }));

export const GPUS = [
  ...g("nvidia", [
    ["GeForce RTX 5090", 32], ["GeForce RTX 5080", 16], ["GeForce RTX 5070 Ti", 16], ["GeForce RTX 5070", 12],
    ["GeForce RTX 5060 Ti 16GB", 16], ["GeForce RTX 5060 Ti 8GB", 8], ["GeForce RTX 5060", 8], ["GeForce RTX 5050", 8],
    ["GeForce RTX 4090", 24], ["GeForce RTX 4080 Super", 16], ["GeForce RTX 4080", 16], ["GeForce RTX 4070 Ti Super", 16],
    ["GeForce RTX 4070 Ti", 12], ["GeForce RTX 4070 Super", 12], ["GeForce RTX 4070", 12],
    ["GeForce RTX 4060 Ti 8GB", 8], ["GeForce RTX 4060 Ti 16GB", 16], ["GeForce RTX 4060", 8],
    ["GeForce RTX 3090 Ti", 24], ["GeForce RTX 3090", 24], ["GeForce RTX 3080 Ti", 12], ["GeForce RTX 3080 12GB", 12],
    ["GeForce RTX 3080", 10], ["GeForce RTX 3070 Ti", 8], ["GeForce RTX 3070", 8], ["GeForce RTX 3060 Ti", 8],
    ["GeForce RTX 3060 12GB", 12], ["GeForce RTX 3060 8GB", 8], ["GeForce RTX 3050", 8], ["GeForce RTX 3050 6GB", 6],
    ["Titan RTX", 24], ["GeForce RTX 2080 Ti", 11], ["GeForce RTX 2080 Super", 8], ["GeForce RTX 2080", 8],
    ["GeForce RTX 2070 Super", 8], ["GeForce RTX 2070", 8], ["GeForce RTX 2060 Super", 8], ["GeForce RTX 2060 12GB", 12], ["GeForce RTX 2060", 6],
    ["GeForce GTX 1660 Super / Ti", 6], ["GeForce GTX 1660", 6], ["GeForce GTX 1650", 4],
    ["GeForce GTX 1080 Ti", 11], ["GeForce GTX 1080", 8], ["GeForce GTX 1070 Ti", 8], ["GeForce GTX 1070", 8],
    ["GeForce GTX 1060 6GB", 6], ["GeForce GTX 1060 3GB", 3], ["GeForce GTX 1050 Ti", 4],
    ["RTX 5090 Laptop", 24], ["RTX 5080 Laptop", 16], ["RTX 5070 Ti Laptop", 12], ["RTX 5070 Laptop", 8], ["RTX 5060 Laptop", 8], ["RTX 5050 Laptop", 8],
    ["RTX 4090 Laptop", 16], ["RTX 4080 Laptop", 12], ["RTX 4070 Laptop", 8], ["RTX 4060 Laptop", 8], ["RTX 4050 Laptop", 6],
    ["RTX 3080 Ti Laptop", 16], ["RTX 3080 Laptop", 8], ["RTX 3070 Ti Laptop", 8], ["RTX 3070 Laptop", 8], ["RTX 3060 Laptop", 6], ["RTX 3050 Laptop", 4],
    ["RTX PRO 6000 Blackwell", 96], ["RTX PRO 5000 Blackwell", 48], ["RTX PRO 4000 Blackwell", 24],
    ["RTX 6000 Ada", 48], ["RTX 5000 Ada", 32], ["RTX 4500 Ada", 24], ["RTX 4000 Ada", 20], ["RTX 2000 Ada", 16],
    ["RTX A6000", 48], ["RTX A5000", 24], ["RTX A4500", 20], ["RTX A4000", 16], ["RTX A2000 12GB", 12], ["RTX A2000", 6],
  ]),
  ...g("unified", [["NVIDIA DGX Spark (128 GB)", 128, { unified: true, ram: 128 }]]),
  ...g("amd", [
    ["Radeon AI PRO R9700", 32], ["Radeon RX 9070 XT", 16], ["Radeon RX 9070", 16], ["Radeon RX 9060 XT 16GB", 16], ["Radeon RX 9060 XT 8GB", 8],
    ["Radeon RX 7900 XTX", 24], ["Radeon RX 7900 XT", 20], ["Radeon RX 7900 GRE", 16], ["Radeon RX 7800 XT", 16],
    ["Radeon RX 7700 XT", 12], ["Radeon RX 7600 XT", 16], ["Radeon RX 7600", 8],
    ["Radeon RX 6950 XT", 16], ["Radeon RX 6900 XT", 16], ["Radeon RX 6800 XT", 16], ["Radeon RX 6800", 16],
    ["Radeon RX 6750 XT", 12], ["Radeon RX 6700 XT", 12], ["Radeon RX 6650 XT", 8], ["Radeon RX 6600 XT", 8], ["Radeon RX 6600", 8],
  ]),
  ...g("unified", [["AMD Ryzen AI Max+ 395 (128 GB)", 128, { unified: true, ram: 128, amd: true }], ["AMD Ryzen AI Max+ 395 (64 GB)", 64, { unified: true, ram: 64, amd: true }]]),
  ...g("intel", [
    ["Intel Arc Pro B60", 24], ["Intel Arc B580", 12], ["Intel Arc B570", 10],
    ["Intel Arc A770 16GB", 16], ["Intel Arc A770 8GB", 8], ["Intel Arc A750", 8], ["Intel Arc A580", 8], ["Intel Arc A380", 6],
  ]),
];

// Find a card by what the user typed ("4070 super", "rx 7900xtx", "arc b580").
export function findGpu(text) {
  const norm = s => String(s || "").toLowerCase().replace(/geforce|radeon|nvidia|amd|intel|graphics/g, "").replace(/[^a-z0-9]+/g, "");
  const q = norm(text);
  if (!q) return null;
  const exact = GPUS.find(x => norm(x.name) === q);
  if (exact) return exact;
  // Prefer an exact name, then a memory variant of it ("3060" -> "3060 12GB",
  // listed first because it's the common one), then anything containing it.
  const rank = x => {
    const n = norm(x.name), i = n.indexOf(q);
    if (i < 0) return 9;
    const rest = n.slice(i + q.length);
    return rest === "" ? 0 : /^\d+gb$/.test(rest) ? 1 : 2;
  };
  const hits = GPUS.map((x, i) => ({ x, i, r: rank(x) })).filter(h => h.r < 9);
  return hits.sort((a, b) => a.r - b.r || a.i - b.i)[0]?.x || null;
}

// ---------- the suggester ----------

// How much of the machine's memory a model can use.
export function usableMemory({ vendor, gb, ram, unified }) {
  if (vendor === "apple" || unified) {
    const total = ram || gb || 0;
    // macOS lets the GPU use about two-thirds of memory up to 36 GB and three-quarters above;
    // Strix Halo and DGX Spark can give the GPU a similar share.
    return Math.floor(total * (total <= 36 ? 0.66 : 0.75));
  }
  return gb || 0;
}

export function runtimeAdvice({ vendor, name = "", os = "windows" }) {
  const n = name.toLowerCase();
  if (vendor === "apple") return { runtime: "ollama-local", also: "lmstudio", why: "Ollama and LM Studio both run well on Apple silicon (LM Studio can also use MLX models)." };
  if (vendor === "intel") return { runtime: "lmstudio", why: "LM Studio runs on Intel Arc through Vulkan with no extra setup." };
  if (vendor === "amd" || /ryzen|radeon/.test(n)) {
    const rdna3plus = /\b(7\d{3}|9\d{3}|r9700)\b/.test(n) || /ryzen ai max/.test(n);
    if (os === "windows" && !rdna3plus) return { runtime: "lmstudio", why: "Ollama's AMD (ROCm) support on Windows starts at the RX 7000 series; LM Studio's Vulkan engine runs this card well." };
    return { runtime: "ollama-local", also: "lmstudio", why: "Ollama supports this card through ROCm. LM Studio (Vulkan) also works." };
  }
  if (/gtx 10|gtx 9|1060|1070|1080|1050/.test(n)) return { runtime: "ollama-local", also: "lmstudio", why: "Ollama supports NVIDIA cards back to the GTX 900 series with driver 550 or newer." };
  return { runtime: "ollama-local", also: "lmstudio", why: "Ollama runs NVIDIA cards out of the box (driver 550 or newer)." };
}

// Pick the top 3 local models for this machine and give each a job on the team.
// input: { gpu?: "RTX 4070", vram?: 12, vendor?, ram?: 32 (system RAM), mac?: true, os? }
export function suggest(input = {}) {
  let card = input.gpu ? findGpu(input.gpu) : null;
  const vendor = input.mac ? "apple" : (card?.vendor === "unified" ? (card.amd ? "amd" : "nvidia") : card?.vendor || input.vendor || "nvidia");
  const unified = !!(input.mac || card?.unified);
  const gb = Number(input.vram) || card?.gb || 0;
  const ram = Number(input.ram) || card?.ram || (unified ? gb : 16);
  const usable = usableMemory({ vendor, gb, ram, unified });
  const label = input.mac ? `Mac with ${ram} GB` : card?.name || (gb ? `${gb} GB graphics card` : "your computer");
  const advice = runtimeAdvice({ vendor, name: input.mac ? "apple" : card?.name || input.gpu || "", os: input.os || (input.mac ? "mac" : "windows") });

  const options = [];
  for (const m of LOCAL_MODELS) {
    if (m.need <= usable) options.push({ ...m, fit: "gpu", rating: m.score });
    else if (!unified && m.moe && m.stretch && usable >= m.stretch.vram && ram >= m.stretch.ram) {
      options.push({ ...m, fit: "split", rating: m.score - 15 });
    }
  }
  const good = options.filter(m => m.rating >= MIN_SCORE).sort((a, b) => b.rating - a.rating || a.need - b.need);

  const result = { machine: label, vendor, usable_gb: usable, system_ram_gb: ram, runtime: advice, researched: RESEARCHED };
  if (!good.length) {
    result.hired = [];
    result.message = usable < 3
      ? "This machine doesn't have enough graphics memory to run a shopper that does the job well. Hire a cloud shopper instead: Gemini and Groq have free plans."
      : "None of the models we trust for shopping fit here. Hire a cloud shopper instead: Gemini and Groq have free plans.";
    return result;
  }

  // Lead: the best model that fits. Second opinion: the best from another
  // maker. Quick shopper: the best that uses at most 60% of the memory (so it
  // runs a lot faster), else the smallest good one left.
  const lead = good[0];
  const second = good.find(m => m !== lead && m.maker !== lead.maker) || good.find(m => m !== lead);
  const rest = good.filter(m => m !== lead && m !== second && m.fit === "gpu");
  const fast = rest.find(m => m.need <= usable * 0.6 && m.rating >= Math.max(MIN_SCORE, lead.rating - 25))
    || rest.sort((a, b) => a.need - b.need)[0] || good.find(m => m !== lead && m !== second);
  const roles = [[lead, "Lead shopper", "Does your lists by default."], [second, "Second opinion", "A different maker's model, for a fresh take on the same list."], [fast, "Quick shopper", "Smaller and faster, for simple lists."]];
  result.hired = roles.filter(([m]) => m).map(([m, role, job]) => ({
    tag: m.tag, name: m.name, maker: m.maker, role, job, size_gb: m.size, needs_gb: m.need, score: m.rating, note: m.note,
    fit: m.fit === "gpu" ? "Runs fully on your graphics card." : `Runs partly on your CPU: slower, but works with ${m.stretch.ram} GB+ of system RAM.`,
    install: advice.runtime === "lmstudio" ? `In LM Studio, search “${m.name}” and download the Q4_K_M version.` : `ollama pull ${m.tag}`,
  }));
  if (result.hired.length < 3) result.message = "Only these models do the job well on this machine. A cloud shopper can fill the rest of the team.";
  return result;
}
