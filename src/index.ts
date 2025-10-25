import * as dotenv from "dotenv";
dotenv.config();

import express, { Request, Response } from "express";
import { pipelineService } from "./service/pipeline.service";
import {
  contentCreationRequestSchema,
  ContentCreationRequest,
} from "./dto/content.request.dto";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/create-content", async (req: Request, res: Response) => {
  try {
    // 1. Zod로 요청 본문 검증
    const validationResult = contentCreationRequestSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        message: "Invalid content creation request data.",
        errors: validationResult.error,
      });
    }

    const creationRequest: ContentCreationRequest = validationResult.data;
    console.log("[Worker] Job accepted:", creationRequest);

    // 2. Spring에게 "일단 접수했다"고 즉시 응답
    res.status(202).json({
      message: "Job accepted and processing.",
      trackId: creationRequest.trackId,
    });

    // 3. (응답 보낸 후) 백그라운드 작업 실행
    pipelineService.run(creationRequest).catch((error) => {
      console.error(
        `[BackgroundJobError] Failed to process job for trackId: ${creationRequest.trackId}`,
        error
      );
    });
  } catch (error) {
    // 이 try-catch는 '접수' 자체의 실패(e.g. req.body가 없음)만 잡습니다.
    console.error("Failed to accept job:", error);
    // (이 시점에서는 이미 응답을 보냈을 수 있으므로, 응답 헤더가 전송되지 않았을 때만 에러 전송)
    if (!res.headersSent) {
      res.status(400).json({ message: "Bad request." });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Content Creation Pipeline server listening on port ${PORT}`);
});
