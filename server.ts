import cors, { type CorsOptions } from "cors";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import { Collection, type Filter, MongoClient, ObjectId, type WithId } from "mongodb";

dotenv.config();

declare global {
    namespace Express {
        interface Request {
            authUser?: {
                id: string;
                role: UserRole;
            };
        }
    }
}

type QueryValue = unknown;

interface CategoryDocument {
    name: string;
    slug: string;
    image: string;
    description: string;
    createdAt: Date;
    updatedAt: Date;
}

interface CourseDocument {
    title: string;
    slug: string;
    thumbnail: string;
    shortDescription: string;
    description: string;
    category: string;
    instructorId: string;
    level: string;
    language: string;
    duration: string;
    price: number;
    discountPrice: number | null;
    requirements: string[];
    outcomes: string[];
    totalLessons: number;
    totalStudents: number;
    status: string;
    createdAt: Date;
    updatedAt: Date;
}

type UserRole = "admin" | "user";

interface UserDocument {
    _id: ObjectId;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    role?: UserRole;
    createdAt: Date;
    updatedAt: Date;
}

interface SessionDocument {
    _id: ObjectId;
    token: string;
    userId: ObjectId | string;
    expiresAt: Date;
}

interface MessageDocument {
    name: string;
    email: string;
    subject: string;
    message: string;
    status: "new" | "read";
    createdAt: Date;
    updatedAt: Date;
}

interface EnrollmentDocument {
    userId: ObjectId;
    courseId: ObjectId;
    courseTitle: string;
    courseThumbnail: string;
    courseSlug: string;
    coursePrice: number;
    status: "active";
    createdAt: Date;
    updatedAt: Date;
}


interface ApiSuccessResponse<T> {
    success: true;
    message: string;
    data: T;
}

interface ApiErrorResponse {
    success: false;
    message: string;
    error: Record<string, unknown>;
}

interface ValidationIssue {
    field: string;
    message: string;
}

interface PaginationResult<T> {
    data: T[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}

interface DashboardSummaryResponse {
    totalCategories: number;
    totalCourses: number;
    totalStudents: number;
    revenue: number;
    recentCourses: Array<Record<string, unknown>>;
}

const app = express();
const port = parsePort(process.env.PORT, 5000);
const mongoUri = requireEnv("MONGODB_URI");
const cloudinaryCloudName = requireEnv("CLOUDINARY_CLOUD_NAME");
const cloudinaryApiKey = requireEnv("CLOUDINARY_API_KEY");
const cloudinaryApiSecret = requireEnv("CLOUDINARY_API_SECRET");

app.disable("x-powered-by");

const corsOrigins = getCorsOrigins(process.env.CORS_ORIGIN);

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

cloudinary.config({
    cloud_name: cloudinaryCloudName,
    api_key: cloudinaryApiKey,
    api_secret: cloudinaryApiSecret,
});

const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: {
        fileSize: 5 * 1024 * 1024,
    },
    fileFilter: (_req, file, callback) => {
        if (!file.mimetype.startsWith("image/")) {
            callback(new Error("Only image uploads are allowed"));
            return;
        }

        callback(null, true);
    },
});

const client = new MongoClient(mongoUri);

let categoryCollection: Collection<CategoryDocument> | null = null;
let courseCollection: Collection<CourseDocument> | null = null;
let userCollection: Collection<UserDocument> | null = null;
let messageCollection: Collection<MessageDocument> | null = null;
let sessionCollection: Collection<SessionDocument> | null = null;
let enrollmentCollection: Collection<EnrollmentDocument> | null = null;

app.get("/", (_req, res) => {
    sendSuccess(res, 200, "Learnify API is running", {
        uptime: process.uptime(),
    });
});

app.get("/health", (_req, res) => {
    sendSuccess(res, 200, "Healthy", {
        status: "ok",
        timestamp: new Date().toISOString(),
    });
});

function getSessionCollection(): Collection<SessionDocument> {
    if (!sessionCollection) {
        throw new Error("Session collection is not initialized");
    }

    return sessionCollection;
}

/**
 * Resolves the Better Auth session cookie set by the Next.js app and
 * verifies it directly against the shared MongoDB "session"/"user"
 * collections (Better Auth and this API connect to the same database).
 * Rejects the request unless the caller has a live session AND role "admin".
 */
const requireAdmin = asyncRoute(async (req, res, next) => {
    const cookieHeader = req.headers.cookie;

    if (!cookieHeader) {
        sendError(res, 401, "Authentication required", {});
        return;
    }

    const cookieToken = extractSessionToken(cookieHeader);

    if (!cookieToken) {
        sendError(res, 401, "Authentication required", {});
        return;
    }

    const sessions = getSessionCollection();
    const session = await sessions.findOne({
        token: cookieToken,
        expiresAt: { $gt: new Date() },
    });

    if (!session) {
        sendError(res, 401, "Session expired or invalid", {});
        return;
    }

    const users = getUserCollection();
    const userId = typeof session.userId === "string" ? parseObjectId(session.userId) : session.userId;

    if (!userId) {
        sendError(res, 401, "Session expired or invalid", {});
        return;
    }

    const user = await users.findOne({ _id: userId as ObjectId });

    if (!user || user.role !== "admin") {
        sendError(res, 403, "Admin access required", {});
        return;
    }

    req.authUser = {
        id: user._id.toHexString(),
        role: "admin",
    };

    next();
});

/**
 * Resolves the Better Auth session cookie and attaches the matching user to
 * the request without requiring any specific role — used for endpoints any
 * signed-in user (student or admin) may call, such as course enrollment.
 */
const requireAuth = asyncRoute(async (req, res, next) => {
    const cookieHeader = req.headers.cookie;

    if (!cookieHeader) {
        sendError(res, 401, "Authentication required", {});
        return;
    }

    const cookieToken = extractSessionToken(cookieHeader);

    if (!cookieToken) {
        sendError(res, 401, "Authentication required", {});
        return;
    }

    const sessions = getSessionCollection();
    const session = await sessions.findOne({
        token: cookieToken,
        expiresAt: { $gt: new Date() },
    });

    if (!session) {
        sendError(res, 401, "Session expired or invalid", {});
        return;
    }

    const users = getUserCollection();
    const userId = typeof session.userId === "string" ? parseObjectId(session.userId) : session.userId;

    if (!userId) {
        sendError(res, 401, "Session expired or invalid", {});
        return;
    }

    const user = await users.findOne({ _id: userId as ObjectId });

    if (!user) {
        sendError(res, 401, "Session expired or invalid", {});
        return;
    }

    req.authUser = {
        id: user._id.toHexString(),
        role: user.role ?? "user",
    };

    next();
});

function extractSessionToken(cookieHeader: string): string | null {
    const cookies = cookieHeader.split(";").map((part) => part.trim());

    for (const cookie of cookies) {
        const separatorIndex = cookie.indexOf("=");
        if (separatorIndex === -1) {
            continue;
        }

        const name = cookie.slice(0, separatorIndex);
        const value = cookie.slice(separatorIndex + 1);

        if (name === "better-auth.session_token" || name === "__Secure-better-auth.session_token") {
            // Better Auth stores the value as "<token>.<signature>"; the raw
            // token (looked up directly in the session collection) is the part
            // before the first dot.
            const decoded = decodeURIComponent(value);
            const dotIndex = decoded.indexOf(".");
            return dotIndex === -1 ? decoded : decoded.slice(0, dotIndex);
        }
    }

    return null;
}

app.get(
    "/dashboard/summary",
    requireAdmin,
    asyncRoute(async (_req, res) => {
        const categories = getCategoryCollection();
        const courses = getCourseCollection();

        const [totalCategories, totalCourses, totals, recentCourses] = await Promise.all([
            categories.countDocuments({}),
            courses.countDocuments({}),
            courses
                .aggregate<{ totalStudents: number; revenue: number }>([
                    {
                        $group: {
                            _id: null,
                            totalStudents: { $sum: "$totalStudents" },
                            revenue: {
                                $sum: {
                                    $ifNull: ["$discountPrice", "$price"],
                                },
                            },
                        },
                    },
                ])
                .toArray(),
            courses.find({}).sort({ createdAt: -1 }).limit(5).toArray(),
        ]);

        const dashboardData: DashboardSummaryResponse = {
            totalCategories,
            totalCourses,
            totalStudents: totals[0]?.totalStudents ?? 0,
            revenue: totals[0]?.revenue ?? 0,
            recentCourses: recentCourses.map(serializeCourse),
        };

        sendSuccess(res, 200, "Dashboard summary fetched successfully", dashboardData);
    })
);

app.post(
    "/upload",
    upload.single("image"),
    async (req, res) => {
        try {
            console.log("========== UPLOAD REQUEST ==========");
            console.log("Headers:", req.headers["content-type"]);
            console.log("File:", req.file);

            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: "Image file is required",
                });
            }

            const secureUrl = await uploadBufferToCloudinary(
                req.file.buffer
            );

            return res.status(201).json({
                success: true,
                message: "Image uploaded successfully",
                data: {
                    secure_url: secureUrl,
                },
            });
        } catch (error) {
            console.error("UPLOAD ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Image upload failed",
                error:
                    error instanceof Error
                        ? error.message
                        : "Unknown error",
            });
        }
    }
);

app.post(
    "/categories",
    requireAdmin,
    asyncRoute(async (req, res) => {
        const categories = getCategoryCollection();
        const body = requireRecordBody(req.body);
        const issues: ValidationIssue[] = [];

        const name = readRequiredString(body.name, "name", issues);
        const image = readRequiredString(body.image, "image", issues);
        const description = readRequiredString(body.description, "description", issues);
        const incomingSlug = readOptionalString(body.slug);

        if (issues.length > 0 || !name || !image || !description) {
            sendError(res, 400, "Validation failed", {
                issues,
            });
            return;
        }

        const slug = await resolveUniqueSlug(categories, incomingSlug ?? name);
        const now = new Date();
        const document: CategoryDocument = {
            name,
            slug,
            image,
            description,
            createdAt: now,
            updatedAt: now,
        };

        const result = await categories.insertOne(document);

        sendSuccess(res, 201, "Category created successfully", serializeCategory({ _id: result.insertedId, ...document }));
    })
);

app.get(
    "/categories",
    asyncRoute(async (req, res) => {
        const categories = getCategoryCollection();
        const search = readQueryString(req.query.search);
        const page = parsePage(req.query.page);
        const limit = parseLimit(req.query.limit, 10, 100);

        const query: Filter<CategoryDocument> = {};
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: "i" } },
                { slug: { $regex: search, $options: "i" } },
                { description: { $regex: search, $options: "i" } },
            ];
        }

        const result = await getPaginatedDocuments(categories, query, {
            page,
            limit,
            sort: { createdAt: -1 },
            serializer: serializeCategory,
        });

        sendSuccess(res, 200, "Categories fetched successfully", result);
    })
);

app.get(
    "/categories/:id",
    asyncRoute(async (req, res) => {
        const categories = getCategoryCollection();
        const id = parseObjectId(req.params.id);

        if (!id) {
            sendError(res, 400, "Invalid category id", {
                issues: [
                    {
                        field: "id",
                        message: "Category id is invalid",
                    },
                ],
            });
            return;
        }

        const category = await categories.findOne({ _id: id });

        if (!category) {
            sendError(res, 404, "Category not found", {
                id: req.params.id,
            });
            return;
        }

        sendSuccess(res, 200, "Category fetched successfully", serializeCategory(category));
    })
);

app.patch(
    "/categories/:id",
    requireAdmin,
    asyncRoute(async (req, res) => {
        const categories = getCategoryCollection();
        const id = parseObjectId(req.params.id);

        if (!id) {
            sendError(res, 400, "Invalid category id", {
                issues: [
                    {
                        field: "id",
                        message: "Category id is invalid",
                    },
                ],
            });
            return;
        }

        const body = requireRecordBody(req.body);
        const issues: ValidationIssue[] = [];
        const name = readOptionalString(body.name);
        const image = readOptionalString(body.image);
        const description = readOptionalString(body.description);
        const incomingSlug = readOptionalString(body.slug);

        if (!name && !image && !description && !incomingSlug) {
            sendError(res, 400, "Validation failed", {
                issues: [
                    {
                        field: "body",
                        message: "At least one field is required for update",
                    },
                ],
            });
            return;
        }

        const existingCategory = await categories.findOne({ _id: id });
        if (!existingCategory) {
            sendError(res, 404, "Category not found", {
                id: req.params.id,
            });
            return;
        }

        if (body.name !== undefined && !name) {
            issues.push({
                field: "name",
                message: "Name cannot be empty",
            });
        }

        if (body.image !== undefined && !image) {
            issues.push({
                field: "image",
                message: "Image cannot be empty",
            });
        }

        if (body.description !== undefined && !description) {
            issues.push({
                field: "description",
                message: "Description cannot be empty",
            });
        }

        if (issues.length > 0) {
            sendError(res, 400, "Validation failed", { issues });
            return;
        }

        const nextName = name ?? existingCategory.name;
        const nextSlug = await resolveUniqueSlug(categories, incomingSlug ?? nextName, id);
        const updatedCategory: Partial<CategoryDocument> = {
            ...(name ? { name } : {}),
            ...(image ? { image } : {}),
            ...(description ? { description } : {}),
            slug: nextSlug,
            updatedAt: new Date(),
        };

        await categories.updateOne(
            {
                _id: id,
            },
            {
                $set: updatedCategory,
            }
        );

        const nextCategory = await categories.findOne({ _id: id });

        if (!nextCategory) {
            sendError(res, 500, "Failed to update category", {
                id: req.params.id,
            });
            return;
        }

        sendSuccess(res, 200, "Category updated successfully", serializeCategory(nextCategory));
    })
);

app.delete(
    "/categories/:id",
    requireAdmin,
    asyncRoute(async (req, res) => {
        const categories = getCategoryCollection();
        const id = parseObjectId(req.params.id);

        if (!id) {
            sendError(res, 400, "Invalid category id", {
                issues: [
                    {
                        field: "id",
                        message: "Category id is invalid",
                    },
                ],
            });
            return;
        }

        const deletedCategory = await categories.findOneAndDelete({ _id: id });

        if (!deletedCategory) {
            sendError(res, 404, "Category not found", {
                id: req.params.id,
            });
            return;
        }

        sendSuccess(res, 200, "Category deleted successfully", serializeCategory(deletedCategory));
    })
);

app.post(
    "/messages",
    asyncRoute(async (req, res) => {
        const messages = getMessageCollection();
        const body = requireRecordBody(req.body);
        const issues: ValidationIssue[] = [];

        const name = readRequiredString(body.name, "name", issues);
        const email = readRequiredString(body.email, "email", issues);
        const message = readRequiredString(body.message, "message", issues);
        const subject = readOptionalString(body.subject) ?? "General Inquiry";

        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            issues.push({
                field: "email",
                message: "email must be a valid email address",
            });
        }

        if (issues.length > 0) {
            sendError(res, 400, "Validation failed", { issues });
            return;
        }

        const now = new Date();
        const document: MessageDocument = {
            name: name as string,
            email: email as string,
            subject,
            message: message as string,
            status: "new",
            createdAt: now,
            updatedAt: now,
        };

        const result = await messages.insertOne(document);

        sendSuccess(
            res,
            201,
            "Message sent successfully",
            serializeMessage({ _id: result.insertedId, ...document })
        );
    })
);

app.get(
    "/messages",
    requireAdmin,
    asyncRoute(async (req, res) => {
        const messages = getMessageCollection();
        const search = readQueryString(req.query.search);
        const status = readQueryString(req.query.status);
        const page = parsePage(req.query.page);
        const limit = parseLimit(req.query.limit, 10, 100);

        const query: Filter<MessageDocument> = {};
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: "i" } },
                { email: { $regex: search, $options: "i" } },
                { subject: { $regex: search, $options: "i" } },
                { message: { $regex: search, $options: "i" } },
            ];
        }

        if (status === "new" || status === "read") {
            query.status = status;
        }

        const result = await getPaginatedDocuments(messages, query, {
            page,
            limit,
            sort: { createdAt: -1 },
            serializer: serializeMessage,
        });

        sendSuccess(res, 200, "Messages fetched successfully", result);
    })
);

app.patch(
    "/messages/:id",
    requireAdmin,
    asyncRoute(async (req, res) => {
        const messages = getMessageCollection();
        const id = parseObjectId(req.params.id);

        if (!id) {
            sendError(res, 400, "Invalid message id", {
                issues: [
                    {
                        field: "id",
                        message: "Message id is invalid",
                    },
                ],
            });
            return;
        }

        const body = requireRecordBody(req.body);
        const status = readOptionalString(body.status);

        if (status !== "new" && status !== "read") {
            sendError(res, 400, "Validation failed", {
                issues: [
                    {
                        field: "status",
                        message: "status must be either \"new\" or \"read\"",
                    },
                ],
            });
            return;
        }

        const updatedMessage = await messages.findOneAndUpdate(
            { _id: id },
            {
                $set: {
                    status,
                    updatedAt: new Date(),
                },
            },
            { returnDocument: "after" }
        );

        if (!updatedMessage) {
            sendError(res, 404, "Message not found", {
                id: req.params.id,
            });
            return;
        }

        sendSuccess(res, 200, "Message updated successfully", serializeMessage(updatedMessage));
    })
);

app.delete(
    "/messages/:id",
    requireAdmin,
    asyncRoute(async (req, res) => {
        const messages = getMessageCollection();
        const id = parseObjectId(req.params.id);

        if (!id) {
            sendError(res, 400, "Invalid message id", {
                issues: [
                    {
                        field: "id",
                        message: "Message id is invalid",
                    },
                ],
            });
            return;
        }

        const deletedMessage = await messages.findOneAndDelete({ _id: id });

        if (!deletedMessage) {
            sendError(res, 404, "Message not found", {
                id: req.params.id,
            });
            return;
        }

        sendSuccess(res, 200, "Message deleted successfully", serializeMessage(deletedMessage));
    })
);

app.post(
    "/courses",
    requireAdmin,
    asyncRoute(async (req, res) => {
        const courses = getCourseCollection();
        const body = requireRecordBody(req.body);
        const issues: ValidationIssue[] = [];

        const title = readRequiredString(body.title, "title", issues);
        const thumbnail = readRequiredString(body.thumbnail, "thumbnail", issues);
        const shortDescription = readRequiredString(body.shortDescription, "shortDescription", issues);
        const description = readRequiredString(body.description, "description", issues);
        const category = readRequiredString(body.category, "category", issues);
        const instructorId = readRequiredString(body.instructorId, "instructorId", issues);
        const level = readRequiredString(body.level, "level", issues);
        const language = readRequiredString(body.language, "language", issues);
        const duration = readRequiredString(body.duration, "duration", issues);
        const status = readRequiredString(body.status, "status", issues);
        const price = readRequiredNumber(body.price, "price", issues);
        const discountPrice = readOptionalNumber(body.discountPrice, "discountPrice", issues);
        const requirements = readStringArray(body.requirements, "requirements", issues);
        const outcomes = readStringArray(body.outcomes, "outcomes", issues);
        const totalLessons = readOptionalNumber(body.totalLessons, "totalLessons", issues) ?? 0;
        const totalStudents = readOptionalNumber(body.totalStudents, "totalStudents", issues) ?? 0;
        const incomingSlug = readOptionalString(body.slug);

        if (issues.length > 0 || !title || !thumbnail || !shortDescription || !description || !category || !instructorId || !level || !language || !duration || !status || price === null) {
            sendError(res, 400, "Validation failed", {
                issues,
            });
            return;
        }

        const slug = await resolveUniqueSlug(courses, incomingSlug ?? title);
        const now = new Date();
        const document: CourseDocument = {
            title,
            slug,
            thumbnail,
            shortDescription,
            description,
            category,
            instructorId,
            level,
            language,
            duration,
            price,
            discountPrice: discountPrice ?? null,
            requirements,
            outcomes,
            totalLessons,
            totalStudents,
            status,
            createdAt: now,
            updatedAt: now,
        };

        const result = await courses.insertOne(document);

        sendSuccess(res, 201, "Course created successfully", serializeCourse({ _id: result.insertedId, ...document }));
    })
);

app.get(
    "/courses",
    asyncRoute(async (req, res) => {
        const courses = getCourseCollection();
        const search = readQueryString(req.query.search);
        const category = readQueryString(req.query.category);
        const level = readQueryString(req.query.level);
        const status = readQueryString(req.query.status);
        const sort = readQueryString(req.query.sort);
        const page = parsePage(req.query.page);
        const limit = parseLimit(req.query.limit, 10, 100);

        const query: Filter<CourseDocument> = {};
        if (search) {
            query.$or = [
                { title: { $regex: search, $options: "i" } },
                { shortDescription: { $regex: search, $options: "i" } },
                { description: { $regex: search, $options: "i" } },
            ];
        }

        if (category) {
            query.category = category;
        }

        if (level) {
            query.level = level;
        }

        if (status) {
            query.status = status;
        }

        const sortOption = resolveCourseSort(sort);
        const result = await getPaginatedDocuments(courses, query, {
            page,
            limit,
            sort: sortOption,
            serializer: serializeCourse,
        });

        sendSuccess(res, 200, "Courses fetched successfully", result);
    })
);

app.get(
    "/courses/:id",
    asyncRoute(async (req, res) => {
        const courses = getCourseCollection();
        const id = parseObjectId(req.params.id);

        if (!id) {
            sendError(res, 400, "Invalid course id", {
                issues: [
                    {
                        field: "id",
                        message: "Course id is invalid",
                    },
                ],
            });
            return;
        }

        const course = await courses.findOne({ _id: id });

        if (!course) {
            sendError(res, 404, "Course not found", {
                id: req.params.id,
            });
            return;
        }

        sendSuccess(res, 200, "Course fetched successfully", serializeCourse(course));
    })
);

app.patch(
    "/courses/:id",
    requireAdmin,
    asyncRoute(async (req, res) => {
        const courses = getCourseCollection();
        const id = parseObjectId(req.params.id);

        if (!id) {
            sendError(res, 400, "Invalid course id", {
                issues: [
                    {
                        field: "id",
                        message: "Course id is invalid",
                    },
                ],
            });
            return;
        }

        const body = requireRecordBody(req.body);
        const existingCourse = await courses.findOne({ _id: id });

        if (!existingCourse) {
            sendError(res, 404, "Course not found", {
                id: req.params.id,
            });
            return;
        }

        const issues: ValidationIssue[] = [];
        const title = readOptionalString(body.title);
        const thumbnail = readOptionalString(body.thumbnail);
        const shortDescription = readOptionalString(body.shortDescription);
        const description = readOptionalString(body.description);
        const category = readOptionalString(body.category);
        const instructorId = readOptionalString(body.instructorId);
        const level = readOptionalString(body.level);
        const language = readOptionalString(body.language);
        const duration = readOptionalString(body.duration);
        const status = readOptionalString(body.status);
        const price = readOptionalNumber(body.price, "price", issues);
        const discountPrice = readOptionalNumber(body.discountPrice, "discountPrice", issues);
        const requirements = readOptionalStringArray(body.requirements, "requirements", issues);
        const outcomes = readOptionalStringArray(body.outcomes, "outcomes", issues);
        const totalLessons = readOptionalNumber(body.totalLessons, "totalLessons", issues);
        const totalStudents = readOptionalNumber(body.totalStudents, "totalStudents", issues);
        const incomingSlug = readOptionalString(body.slug);

        const hasUpdate = Boolean(
            title ||
            thumbnail ||
            shortDescription ||
            description ||
            category ||
            instructorId ||
            level ||
            language ||
            duration ||
            status ||
            price !== null ||
            discountPrice !== null ||
            requirements ||
            outcomes ||
            totalLessons !== null ||
            totalStudents !== null ||
            incomingSlug
        );

        if (!hasUpdate) {
            sendError(res, 400, "Validation failed", {
                issues: [
                    {
                        field: "body",
                        message: "At least one field is required for update",
                    },
                ],
            });
            return;
        }

        if (body.price !== undefined && price === null) {
            issues.push({
                field: "price",
                message: "Price must be a valid number",
            });
        }

        if (body.discountPrice !== undefined && discountPrice === null) {
            issues.push({
                field: "discountPrice",
                message: "Discount price must be a valid number",
            });
        }

        if (body.totalLessons !== undefined && totalLessons === null) {
            issues.push({
                field: "totalLessons",
                message: "Total lessons must be a valid number",
            });
        }

        if (body.totalStudents !== undefined && totalStudents === null) {
            issues.push({
                field: "totalStudents",
                message: "Total students must be a valid number",
            });
        }

        if (issues.length > 0) {
            sendError(res, 400, "Validation failed", { issues });
            return;
        }

        const nextTitle = title ?? existingCourse.title;
        const nextSlug = await resolveUniqueSlug(courses, incomingSlug ?? nextTitle, id);
        const updatedCourse: Partial<CourseDocument> = {
            ...(title ? { title } : {}),
            ...(thumbnail ? { thumbnail } : {}),
            ...(shortDescription ? { shortDescription } : {}),
            ...(description ? { description } : {}),
            ...(category ? { category } : {}),
            ...(instructorId ? { instructorId } : {}),
            ...(level ? { level } : {}),
            ...(language ? { language } : {}),
            ...(duration ? { duration } : {}),
            ...(status ? { status } : {}),
            ...(price !== null ? { price } : {}),
            ...(discountPrice !== null ? { discountPrice } : {}),
            ...(requirements ? { requirements } : {}),
            ...(outcomes ? { outcomes } : {}),
            ...(totalLessons !== null ? { totalLessons } : {}),
            ...(totalStudents !== null ? { totalStudents } : {}),
            slug: nextSlug,
            updatedAt: new Date(),
        };

        await courses.updateOne(
            {
                _id: id,
            },
            {
                $set: updatedCourse,
            }
        );

        const nextCourse = await courses.findOne({ _id: id });

        if (!nextCourse) {
            sendError(res, 500, "Failed to update course", {
                id: req.params.id,
            });
            return;
        }

        sendSuccess(res, 200, "Course updated successfully", serializeCourse(nextCourse));
    })
);

app.delete(
    "/courses/:id",
    requireAdmin,
    asyncRoute(async (req, res) => {
        const courses = getCourseCollection();
        const id = parseObjectId(req.params.id);

        if (!id) {
            sendError(res, 400, "Invalid course id", {
                issues: [
                    {
                        field: "id",
                        message: "Course id is invalid",
                    },
                ],
            });
            return;
        }

        const deletedCourse = await courses.findOneAndDelete({ _id: id });

        if (!deletedCourse) {
            sendError(res, 404, "Course not found", {
                id: req.params.id,
            });
            return;
        }

        sendSuccess(res, 200, "Course deleted successfully", serializeCourse(deletedCourse));
    })
);

app.get(
    "/users",
    requireAdmin,
    asyncRoute(async (req, res) => {
        const users = getUserCollection();
        const search = readQueryString(req.query.search);
        const page = parsePage(req.query.page);
        const limit = parseLimit(req.query.limit, 10, 100);

        const query: Filter<UserDocument> = {};
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: "i" } },
                { email: { $regex: search, $options: "i" } },
            ];
        }

        const total = await users.countDocuments(query);
        const documents = await users
            .find(query)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray();

        const data = documents.map(u => ({
            _id: u._id.toHexString(),
            name: u.name,
            email: u.email,
            emailVerified: u.emailVerified,
            image: u.image,
            role: u.role ?? "user",
            createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : u.createdAt,
            updatedAt: u.updatedAt instanceof Date ? u.updatedAt.toISOString() : u.updatedAt,
        }));

        sendSuccess(res, 200, "Users fetched successfully", {
            data,
            total,
            page,
            limit,
            totalPages: Math.max(1, Math.ceil(total / limit)),
        });
    })
);

app.delete(
    "/users/:id",
    requireAdmin,
    asyncRoute(async (req, res) => {
        const users = getUserCollection();
        const id = parseObjectId(req.params.id);

        if (!id) {
            sendError(res, 400, "Invalid user id", {
                issues: [
                    {
                        field: "id",
                        message: "User id is invalid",
                    },
                ],
            });
            return;
        }

        const deletedUser = await users.findOneAndDelete({ _id: id });

        if (!deletedUser) {
            sendError(res, 404, "User not found", {
                id: req.params.id,
            });
            return;
        }

        sendSuccess(res, 200, "User deleted successfully", {
            _id: deletedUser._id.toHexString(),
            name: deletedUser.name,
            email: deletedUser.email,
        });
    })
);

app.patch(
    "/users/:id/role",
    requireAdmin,
    asyncRoute(async (req, res) => {
        const users = getUserCollection();
        const id = parseObjectId(req.params.id);

        if (!id) {
            sendError(res, 400, "Invalid user id", {
                issues: [
                    {
                        field: "id",
                        message: "User id is invalid",
                    },
                ],
            });
            return;
        }

        const body = requireRecordBody(req.body);
        const role = readOptionalString(body.role);

        if (role !== "admin" && role !== "user") {
            sendError(res, 400, "Validation failed", {
                issues: [
                    {
                        field: "role",
                        message: "role must be either \"admin\" or \"user\"",
                    },
                ],
            });
            return;
        }

        if (req.authUser && req.authUser.id === id.toHexString() && role !== "admin") {
            sendError(res, 400, "Validation failed", {
                issues: [
                    {
                        field: "role",
                        message: "You cannot remove your own admin access",
                    },
                ],
            });
            return;
        }

        const updatedUser = await users.findOneAndUpdate(
            { _id: id },
            {
                $set: {
                    role,
                    updatedAt: new Date(),
                },
            },
            { returnDocument: "after" }
        );

        if (!updatedUser) {
            sendError(res, 404, "User not found", {
                id: req.params.id,
            });
            return;
        }

        sendSuccess(res, 200, "User role updated successfully", {
            _id: updatedUser._id.toHexString(),
            name: updatedUser.name,
            email: updatedUser.email,
            emailVerified: updatedUser.emailVerified,
            image: updatedUser.image,
            role: updatedUser.role ?? "user",
            createdAt: updatedUser.createdAt instanceof Date ? updatedUser.createdAt.toISOString() : updatedUser.createdAt,
            updatedAt: updatedUser.updatedAt instanceof Date ? updatedUser.updatedAt.toISOString() : updatedUser.updatedAt,
        });
    })
);

app.use(
    (
        error: Error,
        _req: Request,
        res: Response<ApiErrorResponse>,
        next: NextFunction
    ) => {
        if (res.headersSent) {
            next(error);
            return;
        }

        if (error.message === "Only image uploads are allowed") {
            sendError(res, 400, error.message, {
                field: "image",
            });
            return;
        }

        if (error instanceof multer.MulterError) {
            sendError(res, 400, error.message, {
                code: error.code,
                field: error.field,
            });
            return;
        }

        if (isDuplicateKeyError(error)) {
            sendError(res, 409, "Duplicate resource", {
                message: error.message,
            });
            return;
        }

        sendError(res, 500, "Internal server error", {
            message: error.message,
        });
    }
);

app.post(
    "/enrollments",
    requireAuth,
    asyncRoute(async (req, res) => {
        if (!req.authUser) {
            sendError(res, 401, "Authentication required", {});
            return;
        }

        const enrollments = getEnrollmentCollection();
        const courses = getCourseCollection();
        const body = requireRecordBody(req.body);
        const issues: ValidationIssue[] = [];

        const courseIdRaw = readRequiredString(body.courseId, "courseId", issues);

        if (issues.length > 0 || !courseIdRaw) {
            sendError(res, 400, "Validation failed", { issues });
            return;
        }

        const courseId = parseObjectId(courseIdRaw);

        if (!courseId) {
            sendError(res, 400, "Invalid course id", {
                issues: [{ field: "courseId", message: "courseId is invalid" }],
            });
            return;
        }

        const course = await courses.findOne({ _id: courseId });

        if (!course) {
            sendError(res, 404, "Course not found", { id: courseIdRaw });
            return;
        }

        const userId = parseObjectId(req.authUser.id);

        if (!userId) {
            sendError(res, 401, "Authentication required", {});
            return;
        }

        const existing = await enrollments.findOne({ userId, courseId });

        if (existing) {
            sendSuccess(res, 200, "You are already enrolled in this course", serializeEnrollment(existing));
            return;
        }

        const now = new Date();
        const document: EnrollmentDocument = {
            userId,
            courseId,
            courseTitle: course.title,
            courseThumbnail: course.thumbnail,
            courseSlug: course.slug,
            coursePrice: course.price,
            status: "active",
            createdAt: now,
            updatedAt: now,
        };

        const result = await enrollments.insertOne(document);

        await courses.updateOne({ _id: courseId }, { $inc: { totalStudents: 1 } });

        sendSuccess(
            res,
            201,
            "Enrolled successfully",
            serializeEnrollment({ _id: result.insertedId, ...document })
        );
    })
);

app.get(
    "/enrollments",
    requireAuth,
    asyncRoute(async (req, res) => {
        if (!req.authUser) {
            sendError(res, 401, "Authentication required", {});
            return;
        }

        const enrollments = getEnrollmentCollection();
        const userId = parseObjectId(req.authUser.id);

        if (!userId) {
            sendError(res, 401, "Authentication required", {});
            return;
        }

        const page = parsePage(req.query.page);
        const limit = parseLimit(req.query.limit, 10, 100);

        const result = await getPaginatedDocuments(enrollments, { userId }, {
            page,
            limit,
            sort: { createdAt: -1 },
            serializer: serializeEnrollment,
        });

        sendSuccess(res, 200, "Enrollments fetched successfully", result);
    })
);

app.get(
    "/enrollments/:courseId",
    requireAuth,
    asyncRoute(async (req, res) => {
        if (!req.authUser) {
            sendError(res, 401, "Authentication required", {});
            return;
        }

        const enrollments = getEnrollmentCollection();
        const userId = parseObjectId(req.authUser.id);
        const courseId = parseObjectId(req.params.courseId);

        if (!userId || !courseId) {
            sendError(res, 400, "Invalid identifier", {});
            return;
        }

        const enrollment = await enrollments.findOne({ userId, courseId });

        sendSuccess(res, 200, "Enrollment status fetched", {
            enrolled: Boolean(enrollment),
            enrollment: enrollment ? serializeEnrollment(enrollment) : null,
        });
    })
);

async function startServer(): Promise<void> {
    try {
        await client.connect();

        const db = client.db("learnify");
        categoryCollection = db.collection<CategoryDocument>("categories");
        courseCollection = db.collection<CourseDocument>("courses");
        userCollection = db.collection<UserDocument>("user");
        messageCollection = db.collection<MessageDocument>("messages");
        sessionCollection = db.collection<SessionDocument>("session");
        enrollmentCollection = db.collection<EnrollmentDocument>("enrollments");

        await Promise.all([
            categoryCollection.createIndex({ slug: 1 }, { unique: true }),
            courseCollection.createIndex({ slug: 1 }, { unique: true }),
            messageCollection.createIndex({ createdAt: -1 }),
            enrollmentCollection.createIndex({ userId: 1, courseId: 1 }, { unique: true }),
            enrollmentCollection.createIndex({ createdAt: -1 }),
        ]);

        app.listen(port, () => {
            console.log(`Learnify API running on port ${port}`);
        });
    } catch (error) {
        console.error("Failed to start Learnify API", error);
        process.exit(1);
    }
}

void startServer();

function asyncRoute(
    handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
        void handler(req, res, next).catch(next);
    };
}

function sendSuccess<T>(res: Response, statusCode: number, message: string, data: T): void {
    const response: ApiSuccessResponse<T> = {
        success: true,
        message,
        data,
    };

    res.status(statusCode).json(response);
}

function sendError(
    res: Response<ApiErrorResponse>,
    statusCode: number,
    message: string,
    error: Record<string, unknown>
): void {
    const response: ApiErrorResponse = {
        success: false,
        message,
        error,
    };

    res.status(statusCode).json(response);
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }

    return value;
}

function parsePort(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return Math.floor(parsed);
}

function getCorsOrigins(value: string | undefined): string[] {
    if (!value) {
        return [];
    }

    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function requireRecordBody(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new Error("Request body must be an object");
    }

    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(value: unknown, field: string, issues: ValidationIssue[]): string | null {
    const parsed = readOptionalString(value);
    if (!parsed) {
        issues.push({
            field,
            message: `${field} is required`,
        });

        return null;
    }

    return parsed;
}

function readOptionalString(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readRequiredNumber(value: unknown, field: string, issues: ValidationIssue[]): number | null {
    const parsed = readOptionalNumber(value, field, issues);
    if (parsed === null) {
        issues.push({
            field,
            message: `${field} is required and must be a valid number`,
        });

        return null;
    }

    return parsed;
}

function readOptionalNumber(
    value: unknown,
    field: string,
    issues: ValidationIssue[]
): number | null {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
        issues.push({
            field,
            message: `${field} must be a valid number`,
        });

        return null;
    }

    return parsed;
}

function readStringArray(
    value: unknown,
    field: string,
    issues: ValidationIssue[]
): string[] {
    if (value === undefined || value === null) {
        return [];
    }

    if (!Array.isArray(value)) {
        issues.push({
            field,
            message: `${field} must be an array of strings`,
        });

        return [];
    }

    return value
        .map((item) => readOptionalString(item))
        .filter((item): item is string => item !== null);
}

function readOptionalStringArray(
    value: unknown,
    field: string,
    issues: ValidationIssue[]
): string[] | null {
    if (value === undefined || value === null) {
        return null;
    }

    if (!Array.isArray(value)) {
        issues.push({
            field,
            message: `${field} must be an array of strings`,
        });

        return null;
    }

    return value
        .map((item) => readOptionalString(item))
        .filter((item): item is string => item !== null);
}

function readQueryString(value: QueryValue): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function parsePage(value: QueryValue): number {
    const parsed = parseInteger(value, 1);
    return parsed < 1 ? 1 : parsed;
}

function parseLimit(value: QueryValue, fallback: number, max: number): number {
    const parsed = parseInteger(value, fallback);
    if (parsed < 1) {
        return fallback;
    }

    return Math.min(parsed, max);
}

function parseInteger(value: QueryValue, fallback: number): number {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== "string") {
        return fallback;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.floor(parsed);
}

function parseObjectId(value: unknown): ObjectId | null {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== "string" || !ObjectId.isValid(raw)) {
        return null;
    }

    return new ObjectId(raw);
}

function slugify(value: string): string {
    const normalized = value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

    return normalized.length > 0 ? normalized : "item";
}

async function resolveUniqueSlug<T extends { slug: string }>(
    collection: Collection<T>,
    source: string,
    excludeId?: ObjectId
): Promise<string> {
    const baseSlug = slugify(source);
    let candidate = baseSlug;
    let suffix = 1;

    while (await collection.findOne(buildSlugQuery(candidate, excludeId))) {
        candidate = `${baseSlug}-${suffix}`;
        suffix += 1;
    }

    return candidate;
}

function buildSlugQuery<T extends { slug: string }>(slug: string, excludeId?: ObjectId): Filter<T> {
    if (!excludeId) {
        return {
            slug,
        } as Filter<T>;
    }

    return {
        slug,
        _id: {
            $ne: excludeId,
        },
    } as Filter<T>;
}

async function uploadBufferToCloudinary(buffer: Buffer): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder: "learnify",
            },
            (error, result) => {
                if (error) {
                    reject(error);
                    return;
                }

                if (!result?.secure_url) {
                    reject(new Error("Cloudinary did not return a secure URL"));
                    return;
                }

                resolve(result.secure_url);
            }
        );

        stream.end(buffer);
    });
}

function serializeCategory(category: WithId<CategoryDocument>): Record<string, unknown> {
    return {
        _id: category._id.toHexString(),
        name: category.name,
        slug: category.slug,
        image: category.image,
        description: category.description,
        createdAt: category.createdAt.toISOString(),
        updatedAt: category.updatedAt.toISOString(),
    };
}

function serializeCourse(course: WithId<CourseDocument>): Record<string, unknown> {
    return {
        _id: course._id.toHexString(),
        title: course.title,
        slug: course.slug,
        thumbnail: course.thumbnail,
        shortDescription: course.shortDescription,
        description: course.description,
        category: course.category,
        instructorId: course.instructorId,
        level: course.level,
        language: course.language,
        duration: course.duration,
        price: course.price,
        discountPrice: course.discountPrice,
        requirements: course.requirements,
        outcomes: course.outcomes,
        totalLessons: course.totalLessons,
        totalStudents: course.totalStudents,
        status: course.status,
        createdAt: course.createdAt.toISOString(),
        updatedAt: course.updatedAt.toISOString(),
    };
}

function serializeEnrollment(enrollment: WithId<EnrollmentDocument>): Record<string, unknown> {
    return {
        _id: enrollment._id.toHexString(),
        userId: enrollment.userId.toHexString(),
        courseId: enrollment.courseId.toHexString(),
        courseTitle: enrollment.courseTitle,
        courseThumbnail: enrollment.courseThumbnail,
        courseSlug: enrollment.courseSlug,
        coursePrice: enrollment.coursePrice,
        status: enrollment.status,
        createdAt: enrollment.createdAt.toISOString(),
        updatedAt: enrollment.updatedAt.toISOString(),
    };
}

function serializeMessage(message: WithId<MessageDocument>): Record<string, unknown> {
    return {
        _id: message._id.toHexString(),
        name: message.name,
        email: message.email,
        subject: message.subject,
        message: message.message,
        status: message.status,
        createdAt: message.createdAt.toISOString(),
        updatedAt: message.updatedAt.toISOString(),
    };
}

type Serializer<T> = (document: WithId<T>) => Record<string, unknown>;

async function getPaginatedDocuments<T extends { createdAt: Date }>(
    collection: Collection<T>,
    filter: Filter<T>,
    options: {
        page: number;
        limit: number;
        sort: Record<string, 1 | -1>;
        serializer: Serializer<T>;
    }
): Promise<PaginationResult<Record<string, unknown>>> {
    const total = await collection.countDocuments(filter);
    const documents = await collection
        .find(filter)
        .sort(options.sort)
        .skip((options.page - 1) * options.limit)
        .limit(options.limit)
        .toArray();

    return {
        data: documents.map(options.serializer),
        total,
        page: options.page,
        limit: options.limit,
        totalPages: Math.max(1, Math.ceil(total / options.limit)),
    };
}

function resolveCourseSort(sort: string | undefined): Record<string, 1 | -1> {
    switch (sort) {
        case "price_asc":
            return { price: 1 };
        case "price_desc":
            return { price: -1 };
        case "students_asc":
            return { totalStudents: 1 };
        case "students_desc":
            return { totalStudents: -1 };
        case "oldest":
            return { createdAt: 1 };
        case "newest":
        default:
            return { createdAt: -1 };
    }
}

function getCategoryCollection(): Collection<CategoryDocument> {
    if (!categoryCollection) {
        throw new Error("Category collection is not initialized");
    }

    return categoryCollection;
}

function getCourseCollection(): Collection<CourseDocument> {
    if (!courseCollection) {
        throw new Error("Course collection is not initialized");
    }

    return courseCollection;
}

function getUserCollection(): Collection<UserDocument> {
    if (!userCollection) {
        throw new Error("User collection is not initialized");
    }

    return userCollection;
}


function getMessageCollection(): Collection<MessageDocument> {
    if (!messageCollection) {
        throw new Error("Message collection is not initialized");
    }

    return messageCollection;
}

function getEnrollmentCollection(): Collection<EnrollmentDocument> {
    if (!enrollmentCollection) {
        throw new Error("Enrollment collection is not initialized");
    }

    return enrollmentCollection;
}

function isDuplicateKeyError(error: Error): boolean {
    return "code" in error && (error as { code?: number }).code === 11000;
}