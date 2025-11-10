import * as dotenv from "dotenv";
dotenv.config();

import express, { Request, Response } from "express";
import { pipelineService } from "./service/pipeline.service";
import {
  contentCreationRequestSchema,
  ContentCreationRequest,
} from "./dto/content.request.dto";
import {
  SongTimingCreationRequest,
  songTimingCreationRequestSchema,
} from "./dto/song.request.dto";
import {
  ContentSuccessResult,
  ContentFailResult,
} from "./dto/content.response.dto";
import {
  LineTTSCreationRequest,
  lineTTSCreationRequestSchema,
} from "./dto/line.request.dto";
import { elevenlabsTTSService } from "./service/tts/elevenlabs-line-tts";
import { songTimingService } from "./service/timing/song-timing";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/create-content", async (req: Request, res: Response) => {
  try {
    const validationResult = contentCreationRequestSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        message: "Invalid content creation request data.",
        errors: validationResult.error,
      });
    }

    const creationRequest: ContentCreationRequest = validationResult.data;
    console.log("[Worker] Job accepted:", creationRequest);

    const result: ContentSuccessResult | ContentFailResult =
      await pipelineService.run(creationRequest);

    if ("error" in result) {
      console.warn(
        `[Worker] Job failed for ${creationRequest.trackId}: ${result.error}`
      );
      return res.status(422).json(result); // 422: Unprocessable Entity
    }

    console.log(`[Worker] Job completed for ${creationRequest.trackId}`);
    return res.status(200).json(result);
  } catch (error) {
    console.error("Failed to accept job:", error);
    if (!res.headersSent) {
      res.status(400).json({ message: "Bad request." });
    }
  }
});

app.post("/tts", async (req: Request, res: Response) => {
  try {
    const validationResult = lineTTSCreationRequestSchema.safeParse(req.body);
    if (!validationResult.success) {
      return res.status(400).json({
        message: "Invalid content creation request data.",
        errors: validationResult.error,
      });
    }

    const creationRequest: LineTTSCreationRequest = validationResult.data;
    console.log("[Worker] Job accepted:", creationRequest);
    await elevenlabsTTSService.retryOne(
      creationRequest.lyricLineId,
      creationRequest.lyricText
    );
    return res.status(201).end();
  } catch (error) {
    console.error("Failed to accept job:", error);
    if (!res.headersSent) {
      res.status(400).json({ message: "Bad request." }).end();
    }
  }
});

app.post("/song-timing", async (req: Request, res: Response) => {
  try {
    const validationResult = songTimingCreationRequestSchema.safeParse(
      req.body
    );
    if (!validationResult.success) {
      return res.status(400).json({
        message: "Invalid content creation request data.",
        errors: validationResult.error,
      });
    }

    const creationRequest: SongTimingCreationRequest = validationResult.data;
    console.log("[Worker] Job accepted:", creationRequest);
    await songTimingService.generate(creationRequest.songId);
    return res.status(201).end();
  } catch (error) {
    console.error("Failed to accept job:", error);
    if (!res.headersSent) {
      res.status(400).json({ message: "Bad request." }).end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Content Creation Pipeline server listening on port ${PORT}`);

  try {
    //  elevenlabsTTSService.startCron("* * * * *"); // 1분마다
  } catch (error) {
    console.error("Failed to initialize or start TtsProcessor:", error);
    process.exit(1);
  }
});
