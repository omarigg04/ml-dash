import { Request } from 'express';
import { File } from 'multer';

declare global {
  namespace Express {
    interface Request {
      file?: File;
      files?: File[] | { [fieldname: string]: File[] };
    }
  }
}
