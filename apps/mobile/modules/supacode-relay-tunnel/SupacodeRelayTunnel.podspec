require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
Pod::Spec.new do |s|
  s.name = 'SupacodeRelayTunnel'
  s.version = package['version']
  s.summary = 'Native encrypted relay doorway for Supacode mobile.'
  s.homepage = 'https://supacode.sh'
  s.license = { :type => 'MIT' }
  s.author = { 'Supacode' => 'hello@supacode.sh' }
  s.platforms = { :ios => '15.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.swift', 'Sources/RelayTunnelCore/**/*.swift'
  s.frameworks = 'Network', 'CryptoKit'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
