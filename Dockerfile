FROM mcr.microsoft.com/dotnet/sdk:8.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_NOLOGO=1
ENV NUGET_XMLDOC_MODE=skip
ENV MSBUILDDISABLENODEREUSE=1

RUN dotnet restore project/Compiler.csproj \
    && dotnet build project/Compiler.csproj -c Release -v q /nologo /m:1

ENV HOST=0.0.0.0
ENV PORT=8765
ENV BUILD_CONFIG=Release

EXPOSE 8765

CMD ["python3", "server.py"]
