import { promises as fs } from "fs";
import * as path from "path";
import { lyricsService } from "./processor/lyrics";
import { romanizeService } from "./processor/romanize";
import { translationService } from "./processor/translation";
import { audioService } from "./processor/audio";
import { ContentCreationRequest } from "../dto/content.request.dto";
import {
  ProcessedLyricSyllable,
  ProcessedLyricLine,
  ContentSuccessResult,
  ContentFailResult,
} from "../dto/content.response.dto";

class PipelineService {
  public async run(request: ContentCreationRequest) {
    const { songId, trackId, title } = request;

    try {
      console.log(`[Pipeline] Starting job for: ${trackId}`);

      // 1. 가사 가져오기
      const lyricsData = await lyricsService.fetchLyrics(trackId);
      console.log(
        `[Pipeline] Fetched Lyrics for ${trackId}:`,
        lyricsData.length
      );

      // 2a. 노래 제목 번역
      const titleTranslated = await translationService.translateText(title);

      // 2b. 가사 번역
      const originalLyricsTexts = lyricsData.map((line) => line.words);
      const translatedLyricsTexts = await translationService.translateBatch(
        originalLyricsTexts
      );

      // 2c. 가사 소절별 처리 (로마자, 오디오)
      // NOTE: rate limit을 피하기 위해 순차 처리로 진행
      const processedLines: ProcessedLyricLine[] = [];

      for (const [idx, lineData] of lyricsData.entries()) {
        const { words, startTimeMs } = lineData;
        const originalText = words;

        console.log(
          `[Pipeline] Processing line ${idx + 1}/${
            lyricsData.length
          }: "${originalText}"`
        );

        // --- 2c-1. 소절(Line) 전체 단위 처리 ---
        const romanizedText = romanizeService.convert(originalText);
        const audioUrl = await audioService.createTTS(originalText); // 소절 전체 오디오
        const translatedText = translatedLyricsTexts[idx];

        // --- 2c-2. 음절(Syllable) 단위 처리 ---
        const characters = originalText.split("");
        const processedSyllables: ProcessedLyricSyllable[] = [];

        // 음절도 순차 처리 (TTS API Rate Limit 회피)
        for (const char of characters) {
          const syllableText = char;
          if (!this.hasKorean(syllableText)) {
            continue;
          }
          const syllableRomanized = romanizeService.convert(syllableText);
          const syllableAudioUrl = await audioService.createTTS(syllableText); // *음절* 오디오

          processedSyllables.push({
            textKor: syllableText,
            romanized: syllableRomanized,
            nativeAudio: syllableAudioUrl,
          });
        }

        // --- 2c-3. 최종 소절 데이터 취합 ---
        processedLines.push({
          startTime: startTimeMs,
          words: originalText,
          romanized: romanizedText,
          translated: translatedText,
          nativeAudio: audioUrl,
          syllables: processedSyllables,
        });
      }

      const successPayload: ContentSuccessResult = {
        songId: songId,
        title: title,
        titleTranslated: titleTranslated,
        lines: processedLines,
      };

      // this.saveDebugFile(successPayload, `${songId}_${title}`); //TODO: remove this. (for debugging)
      console.log(`[Pipeline] Successfully finished job for songId: ${songId}`);
      return successPayload;
    } catch (error) {
      const failPayload: ContentFailResult = {
        songId: songId,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error occurred during processing.",
      };
      return failPayload;
    }
  }

  //TODO: remove this. (for debugging)
  private async saveDebugFile(payload: unknown, prefix: string = "result") {
    const kstFormatter = new Intl.DateTimeFormat("sv", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const kstString = kstFormatter.format(new Date());
    // "2025-10-25 16:30:00" -> "20251025_163000"
    const timestamp = kstString
      .replace(/-/g, "")
      .replace(" ", "_")
      .replace(/:/g, "");
    const filename = `${prefix}_${timestamp}.json`;

    // 2. 저장 경로 설정 (프로젝트 루트/tmp)
    const outputDir = path.join(__dirname, "..", "..", "tmp");
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, filename);

    // 3. JSON으로 변환 (예쁘게 들여쓰기)
    const payloadJson = JSON.stringify(payload, null, 2);

    // 4. 파일 쓰기
    await fs.writeFile(outputPath, payloadJson, "utf-8");
  }

  private hasKorean(text: string): boolean {
    const HANGUL_REGEX = /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/;
    return HANGUL_REGEX.test(text);
  }
}

export const pipelineService = new PipelineService();
