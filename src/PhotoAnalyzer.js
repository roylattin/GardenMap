import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';

// Native placeholder — the on-device photo/light analysis uses browser camera
// and canvas APIs, so it runs in the web build. On native we point users there.
export default function PhotoAnalyzer({ visible, onClose }) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.wrap}>
        <View style={styles.card}>
          <Text style={styles.title}>📷 Photo analysis</Text>
          <Text style={styles.body}>
            Photo & light analysis runs in the GardenMap web app. Open it in your mobile browser to use your
            camera, location, and compass.
          </Text>
          <TouchableOpacity style={styles.btn} onPress={onClose}>
            <Text style={styles.btnText}>Got it</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: '#182611', borderRadius: 16, padding: 20, gap: 12 },
  title: { color: '#eaf5d9', fontSize: 18, fontWeight: '700' },
  body: { color: '#9fb47f', fontSize: 14, lineHeight: 20 },
  btn: { backgroundColor: '#7cb342', borderRadius: 10, padding: 12, alignItems: 'center' },
  btnText: { color: '#12240f', fontWeight: '700' },
});
