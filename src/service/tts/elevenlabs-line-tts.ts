import mysql from "mysql2/promise";
import cron from "node-cron";
import { ElevenLabsClient, ElevenLabs } from "@elevenlabs/elevenlabs-js";
import { Storage, Bucket } from "@google-cloud/storage";

interface LyricLineRow {
  lyric_line_id: number;
  original_text: string;
  native_audio_url: string;
  syllable_timings: string;
}

class ElevenLabsTTSProcessor {
  private dbPool: mysql.Pool;
  private ttsClient: ElevenLabsClient;
  private bucket: Bucket;
  private bucketName: string;
  private readonly KOREAN_VOICE_ID = "ksaI0TCD9BstzEzlxj4q"; //Seulki

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

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ELEVENLABS_API_KEY가 .env 파일에 설정되지 않았습니다. ElevenLabs API 키를 확인해주세요."
      );
    }

    this.ttsClient = new ElevenLabsClient({ apiKey });

    const gcpProjectId = process.env.GCP_PROJECT_ID;
    const gcsBucketName = process.env.GCS_BUCKET_NAME;
    const gcpKeyFilePath = process.env.GCP_SERVICE_KEY_PATH;

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

  public async retryOne(lyricLineId: number, lyricText: string) {
    console.log(`[${new Date().toISOString()}] TTS Job started...`);
    let connection: mysql.PoolConnection | null = null;
    try {
      connection = await this.dbPool.getConnection();
      const rows = await this.fetchLyricById(connection, lyricLineId);
      if (rows.length !== 1) {
        console.log(`Fetch Lyric By Id Failed ${lyricLineId}`);
        return;
      }
      await this.processSingleLine(connection, rows[0], lyricText);
    } catch (error) {
      console.error("Critical error during job execution:", error);
    } finally {
      if (connection) {
        connection.release();
      }
      console.log("TTS job finished.");
    }
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
      const rows = await this.fetchLyricsToProcess(connection, 1);
      if (rows.length === 0) {
        console.log("No lyrics to process.");
        return;
      }

      for (const row of rows) {
        const refinedText = this.refineLyric(row.original_text);
        await this.processSingleLine(connection, row, refinedText);
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
    row: LyricLineRow,
    refinedText: string
  ) {
    const { lyric_line_id, original_text } = row;
    console.log(`Processing ID: ${lyric_line_id} ("${original_text}")`);

    if (!refinedText) {
      console.log(
        `[SKIP] 한글 없음: ID ${lyric_line_id} ("${original_text}")("${refinedText}")`
      );

      await this.updateLyricLine(
        connection,
        original_text,
        "", // native_audio_url: 빈 문자열
        "[]" // syllable_timings: 빈 JSON 배열
      );

      return;
    }

    console.log(
      `[PROCESS] 한글 포함: ID ${lyric_line_id} ("${original_text}")("${refinedText}")`
    );

    try {
      const tts = await this.ttsClient.textToSpeech.convertWithTimestamps(
        this.KOREAN_VOICE_ID,
        {
          text: refinedText,
          modelId: "eleven_multilingual_v2",
          voiceSettings: {
            speed: 0.7,
            stability: 0.9, // 감정/억양
            useSpeakerBoost: true,
            similarityBoost: 0.75, // 목소리 유사도 유지
            style: 0, // 과장 없음
          },
        }
      );

      if (!tts.alignment) {
        console.warn(`[WARN] 타임스탬프 없음: ID ${lyric_line_id}.`);
      }

      if (!tts.audioBase64) {
        throw new Error("TTS API did not return audio content.");
      }

      const audioBase64String: string = tts.audioBase64;
      const audioBuffer: Buffer = Buffer.from(audioBase64String, "base64");

      const ttsUrl = await this.uploadToGcs(
        audioBuffer,
        `lyric-${lyric_line_id}-${Date.now()}`
      );
      const syllableTimingsJson = this.parseTimings(tts);

      await this.updateLyricLine(
        connection,
        original_text,
        ttsUrl,
        syllableTimingsJson
      );
      console.log(
        `✅ SUCCESS: ID ${original_text} updated. URL: ${ttsUrl}  timing: ${syllableTimingsJson}`
      );
    } catch (error) {
      let errorMessage = "An unknown error occurred";
      if (error instanceof Error) {
        errorMessage = error.message;
      }
      console.error(
        `❌ FAILED: ID ${lyric_line_id} ("${original_text}"). Error: ${errorMessage}`
      );
      //   await this.updateLyricLine(
      //     connection,
      //     lyric_line_id,
      //     "ERROR",
      //     JSON.stringify({ error: errorMessage })
      //   );
    }
  }

  private parseTimings(tts: ElevenLabs.AudioWithTimestampsResponse) {
    if (
      !tts.alignment ||
      !tts.alignment.characters ||
      !tts.alignment.characterStartTimesSeconds
    ) {
      console.warn(`타임 스탬프 없음 ${tts}`);
      return "[]";
    }

    const syllableTimings = tts.alignment.characters
      .map((char, index) => {
        return {
          timeSeconds: tts.alignment!.characterStartTimesSeconds[index],
          markName: char,
        };
      })
      .filter((item) => item.markName !== " ");
    return JSON.stringify(syllableTimings);
  }

  private async uploadToGcs(
    audioBuffer: Buffer,
    fileName: string
  ): Promise<string> {
    const gcsFilePath = `tts/elevenlabs-lyrics/${fileName}.mp3`;
    const file = this.bucket.file(gcsFilePath);

    await file.save(audioBuffer, {
      contentType: "audio/mpeg",
    });

    return file.publicUrl();
  }

  private refineLyric(text: string): string {
    // 1. [^가-힣 ] : 한글과 공백이 아닌(^) 모든 문자를 찾습니다.
    // 2. g (global) : 문자열 전체에서 찾습니다.
    // 3. '' : 찾은 문자를 빈 문자열(삭제)로 대체합니다.
    const refined = text.replace(/[^가-힣 ]/g, "");

    // 4. 혹시 모를 연속 공백을 하나로 합치고, 양 끝 공백을 제거합니다.
    return refined.replace(/ +/g, " ").trim();
  }

  private async fetchLyricsToProcess(
    connection: mysql.PoolConnection,
    limit: number
  ): Promise<LyricLineRow[]> {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT lyric_line_id, original_text, native_audio_url
          FROM lyric_line
          WHERE native_audio_url LIKE '%google-lyrics%' OR native_audio_url LIKE '%RETRY%'
          LIMIT ?`,
      [limit]
    );
    return rows as LyricLineRow[];
  }

  private async fetchLyricById(
    connection: mysql.PoolConnection,
    lyricLineId: number
  ): Promise<LyricLineRow[]> {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT lyric_line_id, original_text, native_audio_url
          FROM lyric_line
          WHERE lyric_line_id = ?
      `,
      [lyricLineId]
    );
    return rows as LyricLineRow[];
  }

  private async updateLyricLine(
    connection: mysql.PoolConnection,
    original_text: string,
    ttsUrl: string,
    timingsJson: string
  ) {
    await connection.execute(
      `UPDATE lyric_line 
         SET native_audio_url = ?, syllable_timings = ? 
         WHERE original_text = ?`,
      [ttsUrl, timingsJson, original_text]
    );
  }
}

export const elevenlabsTTSService = new ElevenLabsTTSProcessor();
