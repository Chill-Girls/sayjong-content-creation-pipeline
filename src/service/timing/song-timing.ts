import mysql from "mysql2/promise";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import http from "http";
import https from "https";

interface LyricLineRow {
  lyric_line_id: number;
  original_text: string;
  native_audio_url: string;
  syllable_timings: string;
  song_id: number;
}

interface SongRow {
  song_id: number;
  song_url: string;
  timings: string;
}

interface SyllableTiming {
  timeSeconds: number;
  markName: string;
}

interface LyricWithTimings {
  originalText: string;
  refinedText: string;
  timings: SyllableTiming[];
}

interface PythonTimingResult {
  word: string;
  start: number;
  end: number;
}

class SongTimingService {
  private dbPool: mysql.Pool;

  private readonly PYTHON_EXECUTABLE: string;
  private readonly PYTHON_SCRIPT_PATH: string;
  private readonly TEMP_DIR: string;
  private readonly LINE_SEPARATOR = "||LINE_BREAK||";

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

    this.PYTHON_EXECUTABLE =
      process.env.PYTHON_EXECUTABLE || "/opt/venv/bin/python";
    this.PYTHON_SCRIPT_PATH =
      process.env.PYTHON_SCRIPT_PATH || "/usr/src/app/scripts/process_audio.py";
    this.TEMP_DIR = process.env.TEMP_DIR || "/tmp"; // 임시 파일 저장소

    // 임시 디렉토리 확인 및 생성
    if (!fs.existsSync(this.TEMP_DIR)) {
      fs.mkdirSync(this.TEMP_DIR, { recursive: true });
    }
  }

  public async generate(songId: number) {
    console.log(`[SongTiming] Job starting for songId: ${songId}`);
    let connection: mysql.PoolConnection | null = null;
    try {
      connection = await this.dbPool.getConnection();
      const songRows = await this.fetchSongById(connection, songId);
      if (songRows.length !== 1) {
        throw new Error(`Song with songId ${songId} not found.`);
      }
      const song = songRows[0];

      const lyrics = await this.fetchLyrics(connection, songId);
      if (lyrics.length === 0) {
        console.log(`[SongTiming] No lyrics found for songId: ${songId}.`);
        return;
      }

      const fullLyricsText = lyrics
        .map((line) => this.refineTextForPython(line.original_text))
        .join(` ${this.LINE_SEPARATOR} `);

      const resultWithTimings = await this.getSyllableTimings(
        lyrics,
        song.song_url,
        song.song_id,
        fullLyricsText
      );

      console.log(
        `[SongTiming] Successfully generated timings for songId: ${songId}.`
      );
      console.log(JSON.stringify(resultWithTimings, null, 2)); // 결과 확인용
      await this.updateSongTimings(
        connection,
        songId,
        JSON.stringify(resultWithTimings)
      );
    } catch (error) {
      console.error(
        `[SongTiming] Critical error during job for songId: ${songId}`,
        error
      );
    } finally {
      if (connection) {
        connection.release();
      }
      console.log(`[SongTiming] Job finished for songId: ${songId}.`);
    }
  }

  public async generateFallback(songId: number) {
    console.log(`[SongTiming Fallback] Job starting for songId: ${songId}`);
    let connection: mysql.PoolConnection | null = null;
    try {
      connection = await this.dbPool.getConnection();
      const songRows = await this.fetchSongById(connection, songId);
      if (songRows.length !== 1) {
        throw new Error(`Song with songId ${songId} not found.`);
      }
      const song = songRows[0];

      const lyrics = await this.fetchLyrics(connection, songId);
      if (lyrics.length === 0) {
        console.log(
          `[SongTiming Fallback] No lyrics found for songId: ${songId}.`
        );
        return;
      }

      const fullLyricsText = lyrics
        .map((line) => line.original_text)
        .join(` ${this.LINE_SEPARATOR} `);

      const resultWithTimings = await this.getSyllableTimings(
        lyrics,
        song.song_url,
        song.song_id,
        fullLyricsText
      );

      // 한국어 가사 균등 분배
      const refinedResultWithTimings = resultWithTimings.map(
        (result, lineIdx) => {
          const originTimings = result.timings;

          // .flatMap()을 사용하여 각 단어(timing)를 여러 음절(syllable) 타이밍으로 변환
          const refinedTimings = originTimings.flatMap((timing, wordIdx) => {
            const syllables = timing.markName
              .split(/(?=[가-힣])/)
              .filter(Boolean);
            const syllableCount = syllables.length;

            if (syllableCount <= 1) {
              return timing; // 원본 타이밍("Don't", "한", "♪")을 그대로 반환
            }

            // --- 이 단어의 끝(end) 시간 찾기 ---
            let endTime: number;
            const startTime = timing.timeSeconds;

            if (wordIdx < originTimings.length - 1) {
              // (줄의 마지막 단어가 아님: 다음 단어의 시작 시간
              endTime = originTimings[wordIdx + 1].timeSeconds;
            } else if (lineIdx < resultWithTimings.length - 1) {
              // 줄의 마지막 단어 + 마지막 줄이 아님: 다음 줄의 첫 단어 시작 시간
              const nextLine = resultWithTimings[lineIdx + 1];
              if (nextLine.timings.length > 0) {
                endTime = nextLine.timings[0].timeSeconds;
              } else {
                // 다음 줄에 가사가 없으면 1초의 기본 기간 부여
                endTime = startTime + 1.0;
              }
            } else {
              // 노래의 마지막 줄 + 마지막 단어: 1초의 기본 기간 부여
              endTime = startTime + 1.0;
            }

            // 시작 시간과 끝 시간이 같은 경우 0이 되도록 함
            const duration = Math.max(0, endTime - startTime);
            const syllableDuration = duration / syllableCount;

            // 각 음절에 대한 새 타이밍 객체 배열 생성
            return syllables.map((syllable, sIdx) => ({
              timeSeconds: startTime + syllableDuration * sIdx,
              markName: syllable,
            }));
          });

          // 새롭게 만들어진 refinedTimings 배열로 라인 객체 재구성
          return {
            originalText: result.originalText,
            refinedText: refinedTimings.map((t) => t.markName).join(" "), // "마 시 고"
            timings: refinedTimings,
          };
        }
      );

      console.log(
        `[SongTiming Fallback] Successfully generated timings for songId: ${songId}.`
      );
      console.log(JSON.stringify(refinedResultWithTimings, null, 2)); // 결과 확인용
      await this.updateSongTimings(
        connection,
        songId,
        JSON.stringify(refinedResultWithTimings)
      );
    } catch (error) {
      console.error(
        `[SongTiming Fallback] Critical error during job for songId: ${songId}`,
        error
      );
    } finally {
      if (connection) {
        connection.release();
      }
      console.log(`[SongTiming Fallback] Job finished for songId: ${songId}.`);
    }
  }

  private refineTextForPython(text: string): string {
    // [가-힣] : 한글 음절 1개
    // |        : 또는
    // [^가-힣\s]+ : 한글이 아니고(^) 공백(\s)이 아닌 문자 1개 이상(+)
    const regex = /[가-힣]|[^가-힣\s]+/g;
    const tokens = text.match(regex);

    if (!tokens) {
      return ""; // 빈 줄 처리
    }

    // ["(", "불", "장", "난", ")", "eh"] -> "( 불 장 난 ) eh"
    return tokens.join(" ");
  }

  private async getSyllableTimings(
    lyrics: LyricLineRow[],
    songUrl: string,
    songId: number,
    fullLyricsText: string
  ): Promise<LyricWithTimings[]> {
    const localAudioPath = await this.downloadAudio(songUrl, songId);
    let allPythonResults: PythonTimingResult[] = [];

    try {
      // python 스크립트 실행
      allPythonResults = await this.executeAlignment(
        localAudioPath,
        fullLyricsText
      );
    } catch (error) {
      console.error(`[Alignment] Failed to execute alignment:`, error);
      return lyrics.map((l) => ({
        originalText: l.original_text,
        refinedText: "",
        timings: [],
      }));
    } finally {
      try {
        await fs.promises.unlink(localAudioPath);
        console.log(`[Alignment] Deleted temp audio file: ${localAudioPath}`);
      } catch (e) {
        console.warn(
          `[Alignment] Failed to delete temp audio file: ${localAudioPath}`,
          e
        );
      }
    }

    const results: LyricWithTimings[] = [];
    let currentLineTimings: SyllableTiming[] = [];
    let lineIndex = 0;

    for (const pyResult of allPythonResults) {
      //  Python이 반환한 토큰이 '구분자'인 경우
      if (pyResult.word === this.LINE_SEPARATOR) {
        if (lyrics[lineIndex]) {
          results.push({
            originalText: lyrics[lineIndex].original_text,
            refinedText: currentLineTimings.map((t) => t.markName).join(" "),
            timings: currentLineTimings,
          });
        }
        currentLineTimings = [];
        lineIndex++;
      }
      // Python이 반환한 토큰이 '일반 단어'인 경우
      else if (pyResult.word) {
        currentLineTimings.push({
          timeSeconds: pyResult.start,
          markName: pyResult.word,
        });
      }
    }

    if (currentLineTimings.length > 0 && lyrics[lineIndex]) {
      results.push({
        originalText: lyrics[lineIndex].original_text,
        refinedText: currentLineTimings.map((t) => t.markName).join(" "),
        timings: currentLineTimings,
      });
    }

    // (Python 결과와 원본 라인 수 비교 - 디버깅용)
    if (results.length !== lyrics.length) {
      console.warn(
        `[Timing Mismatch] Expected ${lyrics.length} lines but got ${results.length} lines from Python alignment.`
      );
    }

    return results;
  }

  private async downloadAudio(url: string, songId: number): Promise<string> {
    const tempFileName = `${Date.now()}_${songId}.mp3`;
    const localPath = path.join(this.TEMP_DIR, tempFileName);
    console.log(
      `[Downloader] Downloading audio from ${url} to ${localPath}...`
    );

    const client = url.startsWith("https:") ? https : http;
    const fileStream = fs.createWriteStream(localPath);

    return new Promise((resolve, reject) => {
      client
        .get(url, (response) => {
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `Failed to download audio. Status code: ${response.statusCode}`
              )
            );
            return;
          }
          response.pipe(fileStream);
          fileStream.on("finish", () => {
            fileStream.close();
            console.log(`[Downloader] Audio downloaded to ${localPath}`);
            resolve(localPath);
          });
        })
        .on("error", (err) => {
          fs.unlink(localPath, () => {}); // 에러 시 부분 파일 삭제
          reject(err);
        });
    });
  }

  private async executeAlignment(
    audioFilePath: string,
    lyrics: string
  ): Promise<PythonTimingResult[]> {
    console.log(`[Alignment] Spawning Python script...`);
    console.log(`[Alignment] Audio: ${audioFilePath}`);

    return new Promise((resolve, reject) => {
      const pythonProcess = spawn(this.PYTHON_EXECUTABLE, [
        this.PYTHON_SCRIPT_PATH,
        audioFilePath,
        lyrics,
      ]);

      let jsonData = "";
      let errorData = "";

      pythonProcess.stdout.on("data", (data) => {
        jsonData += data.toString();
      });

      pythonProcess.stderr.on("data", (data) => {
        const logMessage = data.toString().trim();
        if (logMessage) {
          console.log(`[Python stderr]: ${logMessage}`);
          errorData += logMessage + "\n";
        }
      });

      pythonProcess.on("close", (code) => {
        console.log(`[Alignment] Python process closed (Code: ${code})`);
        if (code !== 0) {
          return reject(
            new Error(
              `Python script failed with code ${code}. Stderr: ${errorData}`
            )
          );
        }

        try {
          const jsonStartIndex = jsonData.indexOf("[");
          if (jsonStartIndex === -1) {
            // Python 스크립트가 { "error": "..." }를 반환하는 경우
            const errorStartIndex = jsonData.indexOf("{");
            if (errorStartIndex !== -1) {
              const errorJson = JSON.parse(jsonData.substring(errorStartIndex));
              if (errorJson.error) {
                return reject(
                  new Error(`Python script returned error: ${errorJson.error}`)
                );
              }
            }
            throw new Error("No JSON array ('[') found in Python stdout.");
          }

          const jsonString = jsonData.substring(jsonStartIndex);
          const result = JSON.parse(jsonString);

          if (Array.isArray(result)) {
            console.log(
              `[Alignment] Successfully parsed ${result.length} timed segments.`
            );
            resolve(result as PythonTimingResult[]);
          } else {
            reject(new Error("Python stdout was not a JSON array."));
          }
        } catch (error) {
          let errorMessage = "An unknown error occurred during JSON parsing.";
          if (error instanceof Error) {
            errorMessage = error.message;
          }

          reject(
            new Error(
              `Failed to parse Python JSON output: ${errorMessage}. Raw data: ${jsonData.substring(
                0,
                500
              )}...`
            )
          );
        }
      });

      pythonProcess.on("error", (err) => {
        reject(new Error(`Failed to spawn Python process: ${err.message}`));
      });
    });
  }

  private async fetchSongById(
    connection: mysql.PoolConnection,
    songId: number
  ): Promise<SongRow[]> {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT song_id, song_url
        FROM song
        WHERE song_id = ?
      `,
      [songId]
    );
    return rows as SongRow[];
  }

  private async fetchLyrics(
    connection: mysql.PoolConnection,
    songId: number
  ): Promise<LyricLineRow[]> {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT original_text
          FROM lyric_line
          WHERE song_id = ?
          ORDER BY lyric_line_id ASC
      `,
      [songId]
    );
    return rows as LyricLineRow[];
  }

  private async updateSongTimings(
    connection: mysql.PoolConnection,
    songId: number,
    timingJson: string
  ) {
    await connection.execute(
      `UPDATE song 
         SET timings = ? 
         WHERE song_id = ?`,
      [timingJson, songId]
    );
  }
}

export const songTimingService = new SongTimingService();
