#!/bin/bash

set -e

echo "=== SE Tracker Setup ==="
echo

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Installing..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
    echo "✓ Node.js installed"
else
    echo "✓ Node.js $(node --version) found"
fi

# Install dependencies
echo "Installing dependencies..."
npm install
echo "✓ Dependencies installed"

# Build React bundle
echo "Building React bundle..."
npm run build
echo "✓ React bundle built"

# Create data directory
mkdir -p data
chmod 755 data
echo "✓ Data directory created"

# Setup systemd service
echo
echo "To install as a systemd service, run:"
echo "  sudo cp se-tracker.service /etc/systemd/system/"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable se-tracker"
echo "  sudo systemctl start se-tracker"
echo
echo "Or run manually:"
echo "  npm start"
echo
echo "=== Setup Complete ==="
