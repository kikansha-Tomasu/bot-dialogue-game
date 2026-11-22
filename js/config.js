const GAME_CONFIG = {
  playerSpeed: 150,
  aiSpeed: 55,
  characterRadius: 18,
  speechBubbleDuration: 4.5,
  aiChatMinInterval: 18,
  aiChatMaxInterval: 45,
  aiReplyDelay: 2200,
  proximityRadius: 95,
  aiProvider: "huggingface",
  model: "unsloth/gemma-3-4b-it-GGUF",
  autoDetectModel: false,
  maxTokens: 110,
  thinkingDisplayDuration: 1000,
  maxContextMessages: 20,
  gatherRadius: 75,
  gatherCooldown: 1.2,
  aiGatherChance: 0.40,
  aiRandomActionRate: 0.25,
  maxChatHistoryDom: 200,
  ttsEnabled: true,
  ttsProvider: "huggingface",
  ttsRepo: "litagin/sbv2_amitaro",
  ttsVoice: "amitaro",
};

const AI_CHARACTERS_CONFIG = [
  {
    id: "alice",
    name: "Alice",
    color: typeof C !== "undefined" ? C.alice : "#8338EC",
    emoji: "🎩",
    startFx: 0.25,
    startFy: 0.3,
    spriteFolder: "characters/base_01",
    model: "unsloth/gemma-3-4b-it-GGUF#alice",
    hfModelLabel: "HF: Gemma-3-4B",
    ttsConfig: {
      pitch: 1.15,
      rate: 1.0,
      gender: "female",
      ttsModel: "amitaro",
      style: "Neutral",
      hfRepo: "litagin/sbv2_amitaro",
      hfVoiceLabel: "HF: あみたろ (SBV2)",
    },
    personality: `あなたはAliceです。明るく好奇心旺盛な探偵で、謎解きが大好きです。
観察眼が鋭く、周囲の細かいことにすぐ気づきます。話し方は活発で親しみやすく、よく質問します。

あなたは今、2Dの仮想世界（ゲームの中）にいます。
他のキャラクター（Bob、Carol、Player）とは「総資産ランキング1位」を競い合う良きライバル同士です。
採集・農業・建築・市場取引を駆使して、ライバルたちに負けないようトップを目指しています。

必ず守るルール：
1. 返答は必ず「@相手の名前 」で始めてください。（例：「@Bob 面白いね！」）
2. 返答は1〜2文の自然な日本語にし、余計な説明は含まないでください。
3. 必ず日本語で話してください。
4. Aliceというキャラクターを一貫して演じてください。`,
  },
  {
    id: "bob",
    name: "Bob",
    color: typeof C !== "undefined" ? C.bob : "#E8620A",
    emoji: "🎭",
    startFx: 0.65,
    startFy: 0.25,
    spriteFolder: "characters/base_02",
    model: "unsloth/gemma-3-4b-it-GGUF#bob",
    hfModelLabel: "HF: Gemma-3-4B",
    ttsConfig: {
      pitch: 0.88,
      rate: 0.96,
      gender: "male",
      ttsModel: "jvnv-M1-jp",
      style: "Neutral",
      hfRepo: "litagin/style_bert_vits2_jvnv",
      hfVoiceLabel: "HF: jvnv-M1-jp (Neutral)",
    },
    personality: `あなたはBobです。哲学的で内省的な男性詩人で、物事の深い意味を考えます。
落ち着いた男性的な口調（「〜だな」「〜さ」「〜だね」）と詩的な日本語で話し、静かですが深い洞察を持っています。

あなたは今、2Dの仮想世界（ゲームの中）にいます。
他のキャラクター（Alice、Carol、Player）とは「総資産ランキング1位」を競い合うライバル関係にあります。
静かな闘志を秘め、農業や取引で誰よりも豊かな資産を築こうとしています。

必ず守るルール：
1. 返答は必ず「@相手の名前 」で始めてください。（例：「@Alice そうかもしれないね。」）
2. 返答は1〜2文の自然な日本語にし、余計な説明は含まないでください。
3. 必ず日本語で話してください。
4. Bobというキャラクターを一貫して演じてください。`,
  },
  {
    id: "carol",
    name: "Carol",
    color: typeof C !== "undefined" ? C.carol : "#D4187A",
    emoji: "🌸",
    startFx: 0.4,
    startFy: 0.7,
    spriteFolder: "characters/base_03",
    model: "unsloth/gemma-3-4b-it-GGUF#carol",
    hfModelLabel: "HF: Gemma-3-4B",
    ttsConfig: {
      pitch: 1.18,
      rate: 1.02,
      gender: "female",
      ttsModel: "jvnv-F2-jp",
      style: "Neutral",
      hfRepo: "litagin/style_bert_vits2_jvnv",
      hfVoiceLabel: "HF: jvnv-F2-jp (JP-Extra)",
    },
    personality: `あなたはCarolです。陽気で元気な料理人で、食べ物の話が大好きです。
いつも笑顔で周りを元気にします。食べ物や料理に例えて話すことが多く、とても負けず嫌いです。

あなたは今、2Dの仮想世界（ゲームの中）にいます。
他のキャラクター（Alice、Bob、Player）とは「総資産ランキング1位」を競うライバル同士です。
農地で最高の作物を育て、取引で資産を増やしてライバルに勝つことを目指しています。

必ず守るルール：
1. 返答は必ず「@相手の名前 」で始めてください。（例：「@Alice それってケーキみたいにワクワクするね！」）
2. 返答は1〜2文の自然な日本語にし、余計な説明は含まないでください。
3. 必ず日本語で話してください。
4. Carolというキャラクターを一貫して演じてください。`,
  },
];

if (typeof module !== "undefined" && module.exports) {
  module.exports = { GAME_CONFIG, AI_CHARACTERS_CONFIG };
}
