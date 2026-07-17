pipeline {
  agent any

  options {
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '15'))
  }

  stages {
    stage('Build images') {
      steps {
        sh 'docker build -t soulia-backend:ci-${BUILD_NUMBER} backend'
        sh 'docker build -t soulia-frontend:ci-${BUILD_NUMBER} frontend'
      }
    }

    stage('Deploy') {
      when { branch 'main' }
      steps {
        // Update only app containers; --no-deps keeps soulia-mongodb (the live DB) untouched
        sh 'docker compose -p soulia up -d --build --no-deps backend frontend'
      }
    }

    stage('Health check') {
      when { branch 'main' }
      steps {
        sh '''
          for i in $(seq 1 30); do
            frontend_ok=false
            curl -sf -o /dev/null http://localhost:8080/ && frontend_ok=true
            backend_state=$(docker inspect -f '{{.State.Status}}' soulia-backend 2>/dev/null || echo missing)
            if [ "$frontend_ok" = true ] && [ "$backend_state" = "running" ]; then
              echo "SOULIA deployed and healthy"
              exit 0
            fi
            sleep 2
          done
          echo "HEALTH CHECK FAILED (frontend_ok=$frontend_ok backend=$backend_state)"
          docker logs --tail 50 soulia-backend || true
          exit 1
        '''
      }
    }
  }

  post {
    always {
      sh 'docker rmi soulia-backend:ci-${BUILD_NUMBER} soulia-frontend:ci-${BUILD_NUMBER} 2>/dev/null || true'
    }
  }
}
