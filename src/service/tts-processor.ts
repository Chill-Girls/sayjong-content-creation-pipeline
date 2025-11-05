import mysql from "mysql2/promise";
import cron from "node-cron";
import textToSpeech from "@google-cloud/text-to-speech";
import { v1beta1 } from "@google-cloud/text-to-speech";
import { Bucket, Storage } from "@google-cloud/storage";
import { standardizePronunciation } from "es-hangul";

interface LyricLineRow {
  lyric_line_id: number;
  original_text: string;
  native_audio_url: string;
  syllable_timings: string;
}

interface SSMLResult {
  ssml: string;
  indexToSyllableMap: Record<string, string>; // split() 결과 인덱스, 해당 문자
}

class TTSProcessor {
  private dbPool: mysql.Pool;
  private ttsClient: v1beta1.TextToSpeechClient;
  private bucket: Bucket;
  private bucketName: string;

  constructor() {
    this.dbPool = mysql.createPool({
      host: process.env.DB_HOST || "localhost",
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: parseInt(process.env.DB_PORT || "3306"),
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    const gcpProjectId = process.env.GCP_PROJECT_ID;
    const gcsBucketName = process.env.GCS_BUCKET_NAME;
    const gcpKeyFilePath = process.env.GCP_SERVICE_KEY_PATH;

    this.ttsClient = new textToSpeech.v1beta1.TextToSpeechClient({
      projectId: gcpProjectId,
      keyFilename: gcpKeyFilePath,
    });

    if (!gcpProjectId || !gcsBucketName || !gcpKeyFilePath) {
      throw new Error(
        "GCP_PROJECT_ID, GCS_BUCKET_NAME, GCP_SERVICE_KEY_PATH가 .env에 모두 설정되어야 합니다."
      );
    }

    const storage = new Storage({
      projectId: gcpProjectId,
      keyFilename: gcpKeyFilePath,
    });
    this.bucketName = gcsBucketName;
    this.bucket = storage.bucket(this.bucketName);
  }

  public startCron(schedule: string) {
    console.log(`Cron job scheduled with schedule: "${schedule}"`);
    cron.schedule(schedule, () => {
      this.runJob().catch((err) => {
        let errorMessage = "Cron job execution failed";
        if (err instanceof Error) errorMessage = err.message;
        console.error(
          "Cron job execution failed with error:",
          errorMessage,
          err
        );
      });
    });
  }

  public async runJob() {
    console.log(`[${new Date().toISOString()}] TTS Job started...`);
    let connection: mysql.PoolConnection | null = null;

    try {
      connection = await this.dbPool.getConnection();
      const rows = await this.fetchLyricsToProcess(connection, 2);
      if (rows.length === 0) {
        console.log("No lyrics to process.");
        return;
      }

      for (const row of rows) {
        await this.processSingleLine(connection, row);
      }
    } catch (error) {
      console.error("Critical error during job execution:", error);
    } finally {
      if (connection) {
        connection.release();
      }
      console.log("TTS job finished.");
    }
  }

  private async processSingleLine(
    connection: mysql.PoolConnection,
    row: LyricLineRow
  ) {
    const { lyric_line_id, original_text } = row;
    console.log(`Processing ID: ${lyric_line_id} ("${original_text}")`);
    const HANGUL_REGEX = /[가-힣]/;

    try {
      if (!HANGUL_REGEX.test(original_text)) {
        console.log(
          `[SKIP] 한글 없음: ID ${lyric_line_id} ("${original_text}")`
        );

        await this.updateLyricLine(
          connection,
          lyric_line_id,
          "", // native_audio_url: 빈 문자열
          "[]" // syllable_timings: 빈 JSON 배열
        );
        return;
      }

      console.log(
        `[PROCESS] 한글 포함: ID ${lyric_line_id} ("${original_text}")`
      );

      const { ssml, indexToSyllableMap } = this.generateSSML(original_text);
      const [response] = await this.ttsClient.synthesizeSpeech({
        input: { ssml },
        voice: { languageCode: "ko-KR", name: "ko-KR-Wavenet-B" },
        audioConfig: { audioEncoding: "MP3" },
        enableTimePointing: ["SSML_MARK"] as any,
      });

      if (!response.timepoints) {
        console.warn(`[WARN] 타임스탬프 없음: ID ${lyric_line_id}.`);
      }
      if (!response.audioContent) {
        throw new Error("TTS API did not return audio content.");
      }

      const ttsUrl = await this.uploadToGcs(
        response.audioContent as Buffer,
        `lyric-${lyric_line_id}-${Date.now()}`
      );

      const timingsArray = (response.timepoints || []).map((point) => {
        const indexMark = point.markName || "";
        const syllableMark = indexToSyllableMap[indexMark] || "?";
        return {
          timeSeconds: point.timeSeconds || 0,
          markName: syllableMark,
        };
      });

      const syllableTimingsJson = JSON.stringify(timingsArray);

      await this.updateLyricLine(
        connection,
        lyric_line_id,
        ttsUrl,
        syllableTimingsJson
      );
      console.log(`✅ SUCCESS: ID ${lyric_line_id} updated. URL: ${ttsUrl}`);
    } catch (error) {
      let errorMessage = "An unknown error occurred";
      if (error instanceof Error) {
        errorMessage = error.message;
      }
      console.error(
        `❌ FAILED: ID ${lyric_line_id} ("${original_text}"). Error: ${errorMessage}`
      );
      await this.updateLyricLine(
        connection,
        lyric_line_id,
        "ERROR",
        JSON.stringify({ error: errorMessage })
      );
    }
  }

  private async uploadToGcs(
    audioBuffer: Buffer,
    fileName: string
  ): Promise<string> {
    const gcsFilePath = `tts/google-lyrics/${fileName}.mp3`;
    const file = this.bucket.file(gcsFilePath);

    await file.save(audioBuffer, {
      contentType: "audio/mpeg",
    });

    return file.publicUrl();
  }

  private generateSSML(text: string): SSMLResult {
    const originalGraphemes = text.split("");
    const pronouncedText = standardizePronunciation(text, {
      hardConversion: false,
    });
    const pronouncedGraphemes = pronouncedText.split("");
    console.log(`[eshangul] "${text}" -> "${pronouncedText}"`);

    if (originalGraphemes.length !== pronouncedGraphemes.length) {
      const errorMessage = `[generateSSML] 원본/발음 글자 수 불일치: 원본("${text}", ${originalGraphemes.length}자) vs 발음("${pronouncedText}", ${pronouncedGraphemes.length}자)`;
      console.error(errorMessage);
      throw new Error(errorMessage);
    }

    const hangulRegex = /[가-힣]/;
    let ssmlBody = "";
    const indexToSyllableMap: Record<string, string> = {};

    for (let i = 0; i < originalGraphemes.length; i++) {
      const original = originalGraphemes[i];
      const pronounced = pronouncedGraphemes[i];

      if (hangulRegex.test(original)) {
        const markIndex = String(i);
        ssmlBody += `<mark name="${markIndex}"/>${pronounced}`;
        indexToSyllableMap[markIndex] = original;
      } else if (original === " ") {
        ssmlBody += " ";
      }
      //영문, 구두점 모두 담지 않음
    }
    return {
      ssml: `<speak><prosody rate="x-slow">${ssmlBody}</prosody></speak>`,
      indexToSyllableMap: indexToSyllableMap,
    };
  }

  private async fetchLyricsToProcess(
    connection: mysql.PoolConnection,
    limit: number
  ): Promise<LyricLineRow[]> {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT lyric_line_id, original_text, native_audio_url
        FROM lyric_line
        WHERE syllable_timings IS NULL OR native_audio_url = 'PENDING_TTS_URL'
        LIMIT ?`,
      [limit]
    );
    return rows as LyricLineRow[];
  }

  private async updateLyricLine(
    connection: mysql.PoolConnection,
    id: number,
    ttsUrl: string,
    timingsJson: string
  ) {
    await connection.execute(
      `UPDATE lyric_line 
       SET native_audio_url = ?, syllable_timings = ? 
       WHERE lyric_line_id = ?`,
      [ttsUrl, timingsJson, id]
    );
  }
}

export const ttsService = new TTSProcessor();
