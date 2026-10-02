import { Router, type IRouter } from "express";
import healthRouter from "./health";
import reconstructionRouter from "./reconstruction";

const router: IRouter = Router();

router.use(healthRouter);
router.use(reconstructionRouter);

export default router;
