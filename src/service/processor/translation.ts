import * as deepl from "deepl-node";

class TranslationService {
  private client: deepl.Translator;
  private readonly DEFAULT_TARGET_LANG: deepl.TargetLanguageCode = "en-US";
  private readonly SOURCE_LANG: deepl.SourceLanguageCode = "ko";

  constructor() {
    const authKey = process.env.DEEPL_AUTH_KEY;
    if (!authKey) {
      throw new Error(
        "DEEPL_AUTH_KEY가 .env 파일에 설정되지 않았습니다. DeepL 인증 키를 확인해주세요."
      );
    }

    this.client = new deepl.Translator(authKey);
  }

  public async translateText(
    text: string,
    targetLang: deepl.TargetLanguageCode = this.DEFAULT_TARGET_LANG
  ): Promise<string> {
    if (!text) return "";

    const trimmedText = text.trim();
    if (!this.hasKorean(trimmedText)) {
      console.warn(
        `[TranslationService] 한글이 포함되지 않은 텍스트는 번역하지 않습니다: "${trimmedText}"`
      );
      return trimmedText;
    }

    try {
      const result = await this.client.translateText(
        trimmedText,
        this.SOURCE_LANG,
        targetLang
      );
      return result.text;
    } catch (error) {
      console.error("[TranslationService] Text translation error:", error);
      if (error instanceof Error) {
        throw new Error(`DeepL text translation failed: ${error.message}`);
      }
      throw new Error(
        `DeepL text translation failed: ${String(error) || "Unknown error"}`
      );
    }
  }

  public async translateBatch(
    texts: string[],
    targetLang: deepl.TargetLanguageCode = this.DEFAULT_TARGET_LANG
  ): Promise<string[]> {
    const uniqueLyricsSet = new Set(texts);
    const lyricsToTranslate = [...uniqueLyricsSet]
      .filter((text) => text.trim() !== "")
      .filter((text) => this.hasKorean(text));

    const translationMap = new Map<string, string>();

    try {
      const results = await this.client.translateText(
        lyricsToTranslate,
        this.SOURCE_LANG,
        targetLang
      );
      console.log(
        `실제 라인 수: ${texts.length}, 번역된 라인 수: ${results.length}`
      );
      lyricsToTranslate.forEach((originalText, index) => {
        translationMap.set(originalText, results[index].text);
      });
      return texts.map((text) => translationMap.get(text) || text);
    } catch (error) {
      console.error("[TranslationService] Batch translation error:", error);
      if (error instanceof Error) {
        throw new Error(`DeepL batch translation failed: ${error.message}`);
      }
      throw new Error(
        `DeepL batch translation failed: ${String(error) || "Unknown error"}`
      );
    }
  }

  private hasKorean(text: string): boolean {
    const HANGUL_REGEX = /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/;
    return HANGUL_REGEX.test(text);
  }
}

export const translationService = new TranslationService();
