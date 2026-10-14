// Replacement for the inline Pipeline in the souliahome-deploy Jenkins job.
pipeline {
  agent any

  options {
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '15'))
  }

  stages {
    stage('Update code') {
      steps {
        sh '''
          set -eu
          cd /opt/Souliahome
          git fetch --all --prune
          git reset --hard origin/main
          echo "Deploying commit:"
          git log -1 --oneline
        '''
      }
    }

    stage('Deploy') {
      steps {
        sh '''
          set -eu
          cd /opt/Souliahome
          export BUILD_NUMBER
          docker compose config --quiet
          docker compose up -d --build --no-deps backend frontend
        '''
      }
    }

    stage('Health check') {
      steps {
        // Readiness checks NestJS and MongoDB without attempting authentication.
        sh '''
          set -eu
          cd /opt/Souliahome
          ok=0
          for i in $(seq 1 60); do
            fe=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
              http://127.0.0.1:8082/ || true)
            api=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
              http://127.0.0.1:8082/api/health || true)
            if [ "$fe" = "200" ] && [ "$api" = "200" ]; then
              docker exec soulia-backend node scripts/check-shopify-webhook.cjs
              echo "Souliahome healthy (frontend=$fe readiness=$api)"
              ok=1
              break
            fi
            sleep 2
          done
          if [ "$ok" != "1" ]; then
            echo "HEALTH CHECK FAILED (frontend=$fe readiness=$api)"
            docker compose ps || true
            docker inspect -f '{{.RestartCount}} restarts' soulia-backend || true
            docker logs --tail 80 soulia-backend || true
            docker logs --tail 40 soulia-frontend || true
            exit 1
          fi
        '''
      }
    }

    stage('Notify live release') {
      steps {
        // Runs only after the live API is ready. The helper checks the exact
        // deployed version and deduplicates announcements if this stage retries.
        retry(2) {
          sh '''
            set -eu
            docker exec soulia-backend node scripts/notify-release.cjs "$BUILD_NUMBER"
          '''
        }
      }
    }
  }
}
