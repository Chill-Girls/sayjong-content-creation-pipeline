import mysql from "mysql2/promise";
import cron from "node-cron";
import textToSpeech from "@google-cloud/text-to-speech";
import { v1beta1 } from "@google-cloud/text-to-speech";
import { Bucket, Storage } from "@google-cloud/storage";

interface LyricSyllableRow {
  lyric_syllable_id: number;
  text_kor: string;
  native_audio_url: string;
}

class SyllableTTSService {
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
      const rows = await this.fetchSyllableToProcess(connection, 2);
      if (rows.length === 0) {
        console.log("No lyrics to process.");
        return;
      }

      for (const row of rows) {
        await this.processSyllable(connection, row);
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

  private async processSyllable(
    connection: mysql.PoolConnection,
    row: LyricSyllableRow
  ) {
    const { lyric_syllable_id, text_kor } = row;
    console.log(`Processing ID: ${lyric_syllable_id} all ("${text_kor}")`);

    try {
      const ssml = this.generateSSML(text_kor);
      const [response] = await this.ttsClient.synthesizeSpeech({
        input: { ssml },
        voice: { languageCode: "ko-KR", name: "ko-KR-Wavenet-B" },
        audioConfig: { audioEncoding: "MP3" },
      });

      if (!response.audioContent) {
        throw new Error("TTS API did not return audio content.");
      }

      const ttsUrl = await this.uploadToGcs(
        response.audioContent as Buffer,
        `syllable-${lyric_syllable_id}-${Date.now()}`
      );

      await this.updateSyllables(connection, ttsUrl, text_kor);
      console.log(
        `✅ SUCCESS: ID ${lyric_syllable_id} updated. URL: ${ttsUrl}`
      );
    } catch (error) {
      let errorMessage = "An unknown error occurred";
      if (error instanceof Error) {
        errorMessage = error.message;
      }
      console.error(
        `❌ FAILED: ID ${lyric_syllable_id} ("${text_kor}"). Error: ${errorMessage}`
      );
    }
  }

  private async uploadToGcs(audioBuffer: Buffer, fileName: string) {
    const gcsFilePath = `tts/google-lyrics-syllables/${fileName}.mp3`;
    const file = this.bucket.file(gcsFilePath);
    await file.save(audioBuffer, { contentType: "audio/mpeg" });
    return file.publicUrl();
  }

  private generateSSML(text: string) {
    return `<speak><prosody rate="slow">${text}</prosody></speak>`;
  }

  private async fetchSyllableToProcess(
    connection: mysql.PoolConnection,
    limit: number
  ): Promise<LyricSyllableRow[]> {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT lyric_syllable_id, text_kor, native_audio_url
        FROM lyric_syllable
        WHERE native_audio_url = 'PENDING_TTS_URL'
        LIMIT ?`,
      [limit]
    );
    return rows as LyricSyllableRow[];
  }

  private async updateSyllables(
    connection: mysql.PoolConnection,
    ttsUrl: string,
    textKor: string
  ) {
    await connection.execute(
      `UPDATE lyric_syllable
       SET native_audio_url = ?
       WHERE text_kor = ?`,
      [ttsUrl, textKor]
    );
  }
}

export const syllableTTSService = new SyllableTTSService();
