interface RawSpotifyLine {
  startTimeMs: string;
  words: string;
}

interface RawSpotifyResponse {
  lines: RawSpotifyLine[];
}

class LyricsService {
  public async fetchLyrics(trackId: string): Promise<RawSpotifyLine[]> {
    const SPOTIFY_LYRIC_URL = process.env.SPOTIFY_LYRIC_URL;
    if (!SPOTIFY_LYRIC_URL) {
      console.error("[LyricsService] SPOTIFY_LYRIC_URL is not defined.");
      throw new Error(
        "SPOTIFY_LYRIC_URL is not defined in environment variables."
      );
    }

    const url = new URL(SPOTIFY_LYRIC_URL);
    url.pathname = "/";
    url.searchParams.set("trackid", trackId);

    try {
      const response = await fetch(url.toString());

      if (!response.ok) {
        console.error(
          `[LyricsService] API request failed with status: ${response.status} ${response.statusText}`
        );
        const errorBody = await response.text();
        console.error(`[LyricsService] Error response body: ${errorBody}`);
        throw new Error(`Failed to fetch lyrics: ${response.statusText}`);
      }

      const data = (await response.json()) as RawSpotifyResponse;

      if (!data || !data.lines) {
        console.warn(
          `[LyricsService] API response OK, but 'lines' property is missing or invalid.`
        );
        console.log(
          "[LyricsService] Received data:",
          JSON.stringify(data, null, 2)
        );
        throw new Error("Invalid data structure received from lyrics API.");
      }

      return data.lines;
    } catch (error) {
      console.error(
        `[LyricsService] An error occurred during fetch or JSON parsing:`,
        error
      );
      throw error;
    }
  }
}

export const lyricsService = new LyricsService();
