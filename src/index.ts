import * as dotenv from "dotenv";
dotenv.config();

import express, { Request, Response } from "express";
import { pipelineService } from "./service/pipeline.service";
import { syllableTTSService } from "./service/tts/syllable-tts-processor";
import {
  contentCreationRequestSchema,
  ContentCreationRequest,
} from "./dto/content.request.dto";
import {
  ContentSuccessResult,
  ContentFailResult,
} from "./dto/content.response.dto";

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

app.listen(PORT, () => {
  console.log(`Content Creation Pipeline server listening on port ${PORT}`);

  try {
    syllableTTSService.startCron("* * * * *"); // 1분마다 실행
  } catch (error) {
    console.error("Failed to initialize or start TtsProcessor:", error);
    process.exit(1);
  }
});
