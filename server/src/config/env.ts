const env = {
    DATABASE_URL: process.env.DATABASE_URL || '',
    PORT: Number(process.env.PORT) || 8080,
    HOST: process.env.HOST 
}

export { env };